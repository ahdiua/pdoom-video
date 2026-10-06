import { CLIP, S_A1, S_B0, S_B1, S_C0, S_C1, S_D0, S_END } from '../scenes/paperclips-geo';
import { COMMON, FULLSCREEN } from './common';

// Each field starts on a 16-byte boundary. The CPU writer derives its offsets
// from this table, including the integer nItems field and 64-item array.
export const SCENE_FIELDS = {
  camPos: 'vec3f', camR: 'vec3f', camU: 'vec3f', camF: 'vec3f', focal: 'f32', res: 'vec2f', time: 'f32',
  keyDir: 'vec3f', keyI: 'f32', rimDir: 'vec3f', rimI: 'f32', lampPos: 'vec3f', lampI: 'f32', detailScale: 'f32',
  nItems: 'i32', sT0: 'f32', sH0: 'f32', rad0: 'f32', hot0: 'f32', rad: 'f32', fillT: 'f32', groupHalf: 'vec2f',
  pz: 'f32', ceilZ: 'f32', lowerOn: 'f32', fogK: 'f32', fogFar: 'f32', slitK: 'f32', slitH: 'f32', horizonY: 'f32',
} as const;
export const SCENE_BYTES = (Object.keys(SCENE_FIELDS).length + 64) * 16;

const GEOMETRY = /* wgsl */ `
${Object.entries(CLIP).map(([k, v]) => `const CL_${k} = ${v.toFixed(5)};`).join('\n')}
const CL_SA1 = ${S_A1.toFixed(5)}; const CL_SB0 = ${S_B0.toFixed(5)}; const CL_SB1 = ${S_B1.toFixed(5)};
const CL_SC0 = ${S_C0.toFixed(5)}; const CL_SC1 = ${S_C1.toFixed(5)}; const CL_SD0 = ${S_D0.toFixed(5)}; const CL_SEND = ${S_END.toFixed(5)};
struct Closest { d: f32, s: f32, lat: f32, q: vec2f }
fn clSeg(p: vec2f, y: f32, x0: f32, x1: f32, dir: f32, s0: f32, sT: f32, sH: f32, old: Closest) -> Closest {
  let a = s0 + max(sT - s0, 0.0); let b = s0 + min(sH - s0, abs(x1 - x0));
  if (b < a) { return old; }
  let xa = x0 + (a - s0) * dir; let xb = x0 + (b - s0) * dir;
  let x = clamp(p.x, min(xa, xb), max(xa, xb)); let o = p - vec2f(x, y); let d = length(o);
  if (d < old.d) { return Closest(d, s0 + (x - x0) * dir, o.y * dir, vec2f(x, y)); } return old;
}
fn clArc(p: vec2f, c: vec2f, R: f32, a0: f32, s0: f32, sT: f32, sH: f32, old: Closest) -> Closest {
  let lo = max(sT - s0, 0.0) / R; let hi = min(sH - s0, PI * R) / R;
  if (hi < lo) { return old; }
  let v = p - c; let mid = a0 + PI * .5; let ang = atan2(v.y, v.x);
  var rel = ang - mid; rel -= TAU * floor((rel + PI) / TAU);
  let u0 = clamp(rel + PI * .5, lo, hi); let aa = a0 + u0;
  let q = c + R * vec2f(cos(aa), sin(aa)); let d = length(p - q);
  if (d < old.d) { return Closest(d, s0 + u0 * R, R - length(v), q); } return old;
}
fn clipD(p: vec2f, sT: f32, sH: f32) -> Closest {
  var c = Closest(1e5, 0, 0, vec2f(0));
  c = clSeg(p, CL_YA, CL_XA0 + min(sT, 0.0), CL_XR, 1, min(sT, 0.0), sT, sH, c);
  c = clArc(p, vec2f(CL_XR, 0), CL_R1, -PI * .5, CL_SA1, sT, sH, c);
  c = clSeg(p, CL_YB, CL_XR, CL_XL, -1, CL_SB0, sT, sH, c);
  c = clArc(p, vec2f(CL_XL, CL_R2CY), CL_R2, PI * .5, CL_SB1, sT, sH, c);
  c = clSeg(p, CL_YC, CL_XL, CL_XS, 1, CL_SC0, sT, sH, c);
  c = clArc(p, vec2f(CL_XS, CL_R3CY), CL_R3, -PI * .5, CL_SC1, sT, sH, c);
  return clSeg(p, CL_YD, CL_XS, CL_XD1, -1, CL_SD0, sT, sH, c);
}
fn clipFull(p: vec2f) -> Closest {
  var bd = 1e5; var bl = 0.0; var closest = vec2f(0); var o: vec2f; var d: f32;
  o = p - vec2f(clamp(p.x, CL_XA0, CL_XR), CL_YA); d = dot(o,o);
  if (d < bd) { bd=d; bl=o.y; closest=p-o; }
  o = p - vec2f(clamp(p.x, CL_XL, CL_XR), CL_YB); d = dot(o,o);
  if (d < bd) { bd=d; bl=-o.y; closest=p-o; }
  o = p - vec2f(clamp(p.x, CL_XL, CL_XS), CL_YC); d = dot(o,o);
  if (d < bd) { bd=d; bl=o.y; closest=p-o; }
  o = p - vec2f(clamp(p.x, CL_XD1, CL_XS), CL_YD); d = dot(o,o);
  if (d < bd) { bd=d; bl=-o.y; closest=p-o; }
  bd=sqrt(bd); var v: vec2f; var r: f32;
  v=p-vec2f(CL_XR,0); if (v.x>0) { r=length(v); d=abs(r-CL_R1); if(d<bd){bd=d;bl=CL_R1-r;closest=vec2f(CL_XR,0)+v*(CL_R1/r);} }
  v=p-vec2f(CL_XL,CL_R2CY); if (v.x<0) { r=length(v); d=abs(r-CL_R2); if(d<bd){bd=d;bl=CL_R2-r;closest=vec2f(CL_XL,CL_R2CY)+v*(CL_R2/r);} }
  v=p-vec2f(CL_XS,CL_R3CY); if (v.x>0) { r=length(v); d=abs(r-CL_R3); if(d<bd){bd=d;bl=CL_R3-r;closest=vec2f(CL_XS,CL_R3CY)+v*(CL_R3/r);} }
  return Closest(bd,0,bl,closest);
}
`;

// A direct port of the original fragment algorithms: unchanged iteration
// limits, tolerances, lamp, engraving, AO, shadow rays and preview centre tap.
const SHADE = /* wgsl */ `
fn rotv(v: vec2f, a: f32) -> vec2f { let c=cos(a); let s=sin(a); return vec2f(c*v.x-s*v.y,s*v.x+c*v.y); }
fn hatchW(u0: f32, darkness: f32, fw: f32) -> f32 {
  let f=abs(fract(u0)-.5); let hw=.5*clamp(darkness,0.0,1.0); let aa=max(fw,1e-3);
  let l=1.0-smoothstep(hw-aa,hw+aa,.5-f);
  return mix(l,clamp(darkness,0.0,1.0),smoothstep(.3,.75,fw));
}
fn shadeWireL(P: vec3f,N: vec3f,V: vec3f,theta: f32,wirePx: f32,shadow: f32,ao: f32) -> vec3f {
  let dif=max(dot(N,keyDir),0.0)*shadow;
  let tone=keyI*(.02+.98*pow(dif,1.6))*mix(.35,1.0,ao); let nl=7.0; let u0=theta/PI*nl+.5;
  let fw=nl/max(2.0*wirePx*min(1.0,PX_SCALE*detailScale)*max(sin(theta),.2),.5);
  let cov=hatchW(u0,pow(tone,1.5)*1.15,fw); let Hh=normalize(keyDir+V);
  let spec=pow(max(dot(N,Hh),0.0),60.0)*keyI*shadow;
  var col=C_BONE*.74*cov+C_BONE*.85*smoothstep(.3,.6,spec);
  let nv=max(dot(N,V),0.0);
  let rim=pow(sat(1.0-nv),5.0)*smoothstep(0.0,.7,dot(N,rimDir))*rimI*smoothstep(3.0,12.0,wirePx);
  col+=C_SIGNAL*rim*1.1;
  var Lv=lampPos-P; let Ld=length(Lv); Lv/=Ld; let fall=lampI*60.0/(Ld*Ld+60.0);
  col+=(C_SIGNAL*max(dot(N,Lv),0.0)*fall*1.2+C_EMBER*pow(max(dot(N,normalize(Lv+V)),0.0),30.0)*fall*2.0)*mix(.5,1.0,ao);
  return col;
}
fn lampGlow(ro: vec3f,rd: vec3f,tMax: f32) -> vec3f {
  let lp=lampPos-ro; let tl=dot(lp,rd); if(tl<=0||tl>tMax){return vec3f(0);}
  let apx=length(lp-rd*tl)/tl*focal; let core=exp(-apx*apx/18.0)*6.0;
  let halo=exp(-apx*apx/700.0)*.45+.025/(1.0+apx*apx/12000.0);
  return (vec3f(1,.85,.7)*core+C_SIGNAL*halo)*lampI;
}
`;

const TOP = /* wgsl */ `
fn fillK(cell: vec2f) -> f32 {
  let cc=(cell+.5)*40.0; if(abs(cc.x)<groupHalf.x&&abs(cc.y)<groupHalf.y){return -1;}
  if(fillT<0){return 0;} let dist=max(abs(cc.x)-groupHalf.x,abs(cc.y)-groupHalf.y);
  let t0=dist/1100.0+hash12(cell)*.1; let k=clamp((fillT-t0)/.22,0.0,1.0); return 1.0-pow(1.0-k,3.0);
}
fn topSample(px: vec2f) -> vec3f {
  let rd=normalize(camF*focal+camR*px.x+camU*px.y); let tp=-camPos.z/rd.z;
  let P=camPos+rd*tp; let xy=P.xy; let pxw=tp/focal;
  var bd=1e5; var br=rad; var bl=0.0; var sHit=0.0; var bo=vec2f(0); var who=-1;
  for(var i=0;i<64;i++){
    if(i>=nItems){break;} let it=u.items[i]; let q=xy-it.xy;
    if(dot(q,q)>420.0&&i>0){continue;} let lq=rotv(q,-it.z);
    let sT=select(0.0,sT0,i==0); let sH=select(1e3,sH0,i==0); let r=select(rad,rad0,i==0)*it.w;
    var c: Closest; if(i==0){c=clipD(lq,sT,sH);}else{c=clipFull(lq);}
    if(c.d-r<bd-br){bd=c.d;br=r;bl=select(1.0,-1.0,c.lat<0)*c.d;bo=rotv(lq-c.q,it.z);sHit=c.s;who=i;}
  }
  let cell=floor(xy/40.0); let fk=fillK(cell);
  if(fk>0){
    let cc=(cell+.5)*40.0; let ang=select(0.0,PI*.5,modf(cell.x+cell.y,2.0)>.5);
    let lp=rotv(xy-cc,-ang); let m=clamp(floor(lp.y/10.0+2.0),0.0,3.0);
    for(var j=0;j<2;j++){
      let mm=clamp(m+f32(j)*select(-1.0,1.0,fract(lp.y/10.0)>.5),0.0,3.0);
      let lq=(lp-vec2f(0,(mm-1.5)*10.0))/fk; let c=clipFull(lq); let d2=c.d*fk; let r=rad*fk;
      if(d2-r<bd-br){bd=d2;br=r;bl=select(1.0,-1.0,c.lat<0)*d2;bo=rotv((lq-c.q)*fk,ang);sHit=0;who=999;}
    }
  }
  let z=sqrt(max(br*br-bd*bd,0.0)); let N=normalize(vec3f(bo,z+1e-4)); let theta=atan2(z,bl);
  let cover=clamp(.5-(bd-br)/(pxw/min(1.0,PX_SCALE*detailScale)),0.0,1.0);
  var col=shadeWireL(vec3f(xy,z),N,-rd,theta,2.0*br/pxw,1,1);
  if(who==0){let behind=max(sH0-sHit,0.0);let hk=exp(-behind/5.0);let hotc=heat(.42+.58*hk)*(.9+3.5*hk);col=mix(col,hotc,hot0);}
  let bg=C_INK*(.8+.2*reverseSmooth(1.1,0.0,length(px/res.y))); return mix(bg,col,cover);
}
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  let uv=vec2f(v.uv.x,1.0-v.uv.y); return vec4f(topSample(uv*res-.5*res),1);
}
`;

const MARCH = /* wgsl */ `
fn fillK(cell: vec2f) -> f32 {
  let cc=(cell+.5)*40.0;if(abs(cc.x)<groupHalf.x&&abs(cc.y)<groupHalf.y){return 1;}
  if(fillT<0){return 0;}let dist=max(abs(cc.x)-groupHalf.x,abs(cc.y)-groupHalf.y);
  let t0=dist/1100.0+hash12(cell)*.1;let k=clamp((fillT-t0)/.22,0.0,1.0);return 1.0-pow(1.0-k,3.0);
}
struct Hit { d: f32, info: vec4f }
fn layerD(q: vec3f,k: f32) -> Hit {
  var info=vec4f(0,0,0,k); if(abs(q.z)>1.3){return Hit(abs(q.z)-.9,info);}
  var off=vec2f(0);if(k>.5){off=floor(hash22(vec2f(k,7.3))*4.0)*40.0+vec2f(0,20)*modf(k,2.0);}
  let xy=q.xy+off;let cell=floor(xy/40.0);let cc=(cell+.5)*40.0;
  let ang=select(0.0,PI*.5,modf(cell.x+cell.y+k,2.0)>.5);let lp=rotv(xy-cc,-ang);
  let border=20.0-max(abs(lp.x),abs(lp.y));var fk=1.0;if(k<.5){fk=fillK(cell);}
  if(fk<=0){return Hit(max(border,0.0)+.5,info);}
  let m=clamp(floor(lp.y/10.0+2.0),0.0,3.0);var best=1e5;let jit=select(0.0,1.0,k>.5);
  for(var j=0;j<2;j++){
    let mm=clamp(m+f32(j)*select(-1.0,1.0,fract(lp.y/10.0)>.5),0.0,3.0);
    let h=hash33(vec3f(cell,k*7.0+mm));if(jit>.5&&h.x<.1){continue;}
    let cp=vec2f((h.y-.5)*3.0*jit,(mm-1.5)*10.0);let lq=rotv(lp-cp,-(h.z-.5)*.08*jit)/fk;
    let zz=q.z-(h.x-.5)*.3*jit;let bb=vec3f(abs(lq.x-.275)-16.2,abs(lq.y)-4.05,abs(zz/fk)-.45);
    let bx=length(max(bb,vec3f(0)))*fk;if(bx>.35){best=min(best,bx);continue;}
    let c=clipFull(lq);let d2=c.d*fk;let d=sqrt(d2*d2+zz*zz)-rad*fk;
    if(d<best){best=d;info=vec4f(select(1.0,-1.0,c.lat<0)*d2,zz,0,k);}
  }
  return Hit(min(best,max(border,0.0)+.5),info);
}
fn stackD(p: vec3f,base: f32,dirz: f32,seed: f32) -> Hit {
  let h=(p.z-base)*dirz;let k0=max(floor(h/-pz),0.0);
  let a=layerD(vec3f(p.xy,h+k0*pz),k0+seed);let b=layerD(vec3f(p.xy,h+(k0+1.0)*pz),k0+1.0+seed);
  if(a.d<b.d){return a;}return b;
}
fn map(p: vec3f) -> Hit {
  var a=stackD(p,0,1,0);if(ceilZ<900){let b=stackD(p,ceilZ,-1,100);if(b.d<a.d){a=b;}}return a;
}
fn mapD(p: vec3f) -> f32 { return map(p).d; }
fn calcN(p: vec3f,e: f32) -> vec3f {
  let k=vec2f(1,-1);return normalize(k.xyy*mapD(p+k.xyy*e)+k.yyx*mapD(p+k.yyx*e)+k.yxy*mapD(p+k.yxy*e)+k.xxx*mapD(p+k.xxx*e));
}
fn fogCol(rd: vec3f) -> vec3f { return C_INK*.9+C_INK2*.35*exp(-abs(rd.z)*18.0); }
fn softShadow(ro: vec3f,rd: vec3f,eps: f32) -> f32 {
  var shadowResult=1.0;var t=.08+4.0*eps;
  for(var i=0;i<28;i++){
    let h=mapD(ro+rd*t);shadowResult=min(shadowResult,8.0*h/t);t+=clamp(h,.04,.7);
    if(shadowResult<.02||t>14){break;}
  }return smoothstep(0.0,1.0,clamp(shadowResult,0.0,1.0));
}
fn calcAO(p: vec3f,n: vec3f) -> f32 {
  var occ=0.0;var sca=1.0;for(var i=0;i<5;i++){let h=.04+.22*f32(i);occ+=(h-mapD(p+n*h))*sca;sca*=.75;}
  return clamp(1.0-1.6*occ,0.0,1.0);
}
fn shadeAt(ro: vec3f,rd: vec3f,t: f32) -> vec3f {
  let P=ro+rd*t;let info=map(P).info;let N=calcN(P,.002+.0006*t);let wirePx=2.0*rad*focal/t;
  let fogA=1.0-exp(-t*fogK);var sh=1.0;var ao=1.0;let eps=.1*t/focal;let nearK=smoothstep(6.0,16.0,wirePx);
  if(fogA<.97&&nearK>0){sh=mix(1.0,softShadow(P+N*(.02+2.0*eps),keyDir,eps),nearK);ao=mix(1.0,calcAO(P+N*eps,N),nearK);}
  var c=shadeWireL(P,N,-rd,atan2(info.y,info.x),wirePx,sh,ao);
  let k=select(info.w,info.w-100.0,info.w>=100.0);c*=pow(.5,k)*select(1.0,lowerOn,k>.5&&info.w<100);
  return mix(c,fogCol(rd),fogA);
}
fn trace(rd: vec3f) -> vec3f {
  let ro=camPos;let pa=1.0/focal;var hit=false;let zTop=.75;let zBot=ceilZ-.75;var t=.02;
  if(ro.z>zTop&&ro.z<zBot){
    var te=1e9;if(rd.z < -1e-5){te=(ro.z-zTop)/-rd.z;}else if(rd.z>1e-5){te=(zBot-ro.z)/rd.z;}
    t=max(te-.05,.02);
  }
  let zDeep=-4.5*pz;
  for(var i=0;i<128;i++){
    if(t>fogFar){break;}let p=ro+rd*t;let d=mapD(p);let pr=t*pa;
    if(d<.1*pr){hit=true;break;}t+=max(d*.9,pr*(.2+t*.003));if(p.z<zDeep){t=1e5;break;}
  }
  var col=fogCol(rd);if(hit){col=shadeAt(ro,rd,t);}return col+lampGlow(ro,rd,select(1e5,t,hit));
}
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  let uv=vec2f(v.uv.x,1.0-v.uv.y);let px=uv*res-.5*res;
  if(slitK>=1&&abs(px.y-horizonY)>=slitH+30){return vec4f(0,0,0,1);}
  let rd=normalize(camF*focal+camR*px.x+camU*px.y);var col=trace(rd);
  let sm=reverseSmooth(slitH+30.0,slitH,abs(px.y-horizonY));col*=mix(1.0,sm,slitK);return vec4f(col,1);
}
`;

const DECLARATIONS = `struct Uniforms {\n${Object.entries(SCENE_FIELDS).map(([name, type]) => `@align(16) ${name}: ${type},`).join('\n')}\n@align(16) items: array<vec4f,64>,\n}\n@group(0) @binding(0) var<uniform> u: Uniforms;`;
function shader(body: string) {
  const names = Object.keys(SCENE_FIELDS).join('|');
  return FULLSCREEN + COMMON + DECLARATIONS + GEOMETRY + (SHADE + body).replace(new RegExp(`\\b(${names})\\b`, 'g'), 'u.$1');
}
export const TOP_WGSL = shader(TOP);
export const MARCH_WGSL = shader(MARCH);
