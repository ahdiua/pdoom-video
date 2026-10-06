import { COMMON, FULLSCREEN } from './common';
import { SCALE } from '../engine/scale';

export const POST_HEADER = FULLSCREEN + COMMON + /* wgsl */ `
struct Params { v: array<vec4f, 8> }
@group(0) @binding(0) var<uniform> p: Params;
@group(0) @binding(1) var linearSampler: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;
@group(0) @binding(3) var prev: texture_2d<f32>;
@group(0) @binding(4) var hud: texture_2d<f32>;
@group(0) @binding(5) var halo: texture_2d<f32>;
fn sample(t: texture_2d<f32>, uv: vec2f) -> vec4f { return textureSampleLevel(t, linearSampler, uv, 0); }
`;
export const DECODE = POST_HEADER + /* wgsl */ `
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  let c = textureLoad(src, vec2i(v.position.xy), 0); return vec4f(toLinear(c.rgb), c.a);
}`;
export const OVERLAY = POST_HEADER + /* wgsl */ `
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  let c=sample(src,v.uv); return vec4f(c.rgb*c.a,c.a);
}`;
export const BLIT = POST_HEADER + /* wgsl */ `
@fragment fn fragment(v: Vertex) -> @location(0) vec4f { return sample(src,v.uv); }
`;
export const PREFILTER = POST_HEADER + /* wgsl */ `
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  let texel=p.v[0].xy; let threshold=p.v[0].z; let knee=p.v[0].w; var c=vec3f(0);
  ${SCALE === 1 ? `
  c+=sample(src,v.uv+texel*vec2f(-1,-1)).rgb;c+=sample(src,v.uv+texel*vec2f(1,-1)).rgb;
  c+=sample(src,v.uv+texel*vec2f(-1,1)).rgb;c+=sample(src,v.uv+texel*vec2f(1,1)).rgb;c*=.25;
  ` : `
  for(var j=0;j<${SCALE * 2};j++){for(var i=0;i<${SCALE * 2};i++){
    c+=sample(src,v.uv+texel*(vec2f(f32(i),f32(j))*2.0-${(SCALE * 2 - 1).toFixed(1)})/PX_SCALE).rgb;
  }}c/=${(SCALE * SCALE * 4).toFixed(1)};
  `}
  c=min(c,vec3f(40));let l=max(c.r,max(c.g,c.b));var rq=clamp(l-threshold+knee,0.0,2.0*knee);
  rq=rq*rq/(4.0*knee+1e-5);let w=max(rq,l-threshold)/max(l,1e-5);return vec4f(c*w,1);
}`;
export const DOWN = POST_HEADER + /* wgsl */ `
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  let texel=p.v[0].xy;
  let a=sample(src,v.uv+texel*vec2f(-2,-2)).rgb;let b=sample(src,v.uv+texel*vec2f(0,-2)).rgb;let c=sample(src,v.uv+texel*vec2f(2,-2)).rgb;
  let d=sample(src,v.uv+texel*vec2f(-1,-1)).rgb;let e=sample(src,v.uv+texel*vec2f(1,-1)).rgb;
  let f=sample(src,v.uv+texel*vec2f(-2,0)).rgb;let g=sample(src,v.uv).rgb;let h=sample(src,v.uv+texel*vec2f(2,0)).rgb;
  let i=sample(src,v.uv+texel*vec2f(-1,1)).rgb;let j=sample(src,v.uv+texel*vec2f(1,1)).rgb;
  let k=sample(src,v.uv+texel*vec2f(-2,2)).rgb;let l=sample(src,v.uv+texel*vec2f(0,2)).rgb;let m=sample(src,v.uv+texel*vec2f(2,2)).rgb;
  let o=(d+e+i+j)*.125+(a+b+g+f)*.03125+(b+c+h+g)*.03125+(f+g+l+k)*.03125+(g+h+m+l)*.03125;
  return vec4f(o,1);
}`;
export const UP = POST_HEADER + /* wgsl */ `
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  let o=p.v[0].xy*p.v[0].z;
  let s=sample(src,v.uv-o).rgb+2.0*sample(src,v.uv+vec2f(0,-o.y)).rgb+sample(src,v.uv+vec2f(o.x,-o.y)).rgb
    +2.0*sample(src,v.uv+vec2f(-o.x,0)).rgb+4.0*sample(src,v.uv).rgb+2.0*sample(src,v.uv+vec2f(o.x,0)).rgb
    +sample(src,v.uv+vec2f(-o.x,o.y)).rgb+2.0*sample(src,v.uv+vec2f(0,o.y)).rgb+sample(src,v.uv+o).rgb;
  return vec4f(sample(prev,v.uv).rgb+s/16.0,1);
}`;
export const FINAL = POST_HEADER + /* wgsl */ `
fn shoulder(x: vec3f) -> vec3f {
  let k=.72;let y=select(x,vec3f(k)+(1.0-k)*(1.0-exp(-(x-k)/(1.0-k))),x>=vec3f(k));
  let over=max(x.r,max(x.g,x.b));return mix(y,vec3f(1),smoothstep(2.0,12.0,over)*.85);
}
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  let res=p.v[0].xy;let time=p.v[0].z;let zoom=p.v[0].w;let shake=p.v[1].xy;
  let exposure=p.v[1].z;let bloom=p.v[1].w;let halation=p.v[2].x;let ca=p.v[2].y;
  let grain=p.v[2].z;let vignette=p.v[2].w;let hudOpacity=p.v[3].x;let fade=p.v[3].y;let flash=p.v[3].z;let invert=p.v[3].w;
  // Convert the authored bottom-up shake and CA to top-down texture UVs.
  let glUV=vec2f(v.uv.x,1.0-v.uv.y);let uvGL=(glUV-.5)/zoom+.5-shake/res;
  let dc=uvGL-.5;let r2=dot(dc*vec2f(res.x/res.y,1),dc*vec2f(res.x/res.y,1));
  let offGL=dc*r2*ca/res.x*4.0;let uv=vec2f(uvGL.x,1.0-uvGL.y);let off=offGL*vec2f(1,-1);
  var col=vec3f(sample(src,uv+off).r,sample(src,uv).g,sample(src,uv-off).b);
  col+=sample(prev,uv).rgb*bloom;col+=vec3f(1,.18,.04)*luma(sample(halo,uv).rgb)*halation;col*=exposure;
  let h=sample(hud,v.uv);col=mix(col,h.rgb/max(h.a,1e-4),h.a*hudOpacity);
  col=shoulder(col);col=mix(col,vec3f(.8515)-col*.84,invert);col+=C_BONE*flash;
  let vig=reverseSmooth(.95,.25,length(dc*vec2f(1,.8)));col*=mix(1.0,vig,vignette);col*=1.0-fade;
  var s=toSRGB(clamp(col,vec3f(0),vec3f(1)));
  let fragPx=vec2f(v.position.x, f32(textureDimensions(src).y)-v.position.y);
  if(grain>0){
    let g1=(hash12(fragPx+fract(time*13.37)*1000.0)-.5)*PX_SCALE;
    let g2=hash12(floor(fragPx/(2.0*PX_SCALE))+fract(time*7.13)*1000.0)-.5;
    let lm=sat(luma(s));let amt=grain*(.55+1.2*lm*(1.0-lm));s+=(g1*.6+g2*.4)*amt;
  }
  s+=(hash12(fragPx*1.37+time)-.5)/255.0;return vec4f(clamp(s,vec3f(0),vec3f(1)),1);
}`;

export const LINES = /* wgsl */ `
struct Params { res: vec2f, scale: f32, padding: f32 }
@group(0) @binding(0) var<uniform> p: Params;
struct Vertex { @builtin(position) position: vec4f, @location(0) local: vec2f,
  @location(1) len: f32, @location(2) halfW: f32, @location(3) color: vec4f }
@vertex fn vertex(@builtin(vertex_index) i: u32,@location(0) a: vec2f,@location(1) b: vec2f,@location(2) width: f32,@location(3) color: vec4f) -> Vertex {
  let corners=array<vec2f,6>(vec2f(0,-1),vec2f(1,-1),vec2f(1,1),vec2f(0,-1),vec2f(1,1),vec2f(0,1));let q=corners[i];
  let sa=(a-vec2f(p.res.x*.5,p.res.y*.5))*vec2f(1,-1)*p.scale;
  let sb=(b-vec2f(p.res.x*.5,p.res.y*.5))*vec2f(1,-1)*p.scale;let w=width*p.scale;
  let hw=max(w*.5,.35)+1.0;let d=sb-sa;let len=length(d);var dir=vec2f(1,0);if(len>1e-4){dir=d/len;}
  let n=vec2f(-dir.y,dir.x);let along=mix(-hw,len+hw,q.x);let pos=sa+dir*along+n*q.y*hw;
  var o: Vertex;o.position=vec4f(pos/(.5*p.res*p.scale),0,1);o.local=vec2f(along,q.y*hw);o.len=len;o.halfW=max(w*.5,.35);
  o.color=color*vec4f(1,1,1,min(1.0,w/.7));return o;
}
@fragment fn fragment(v: Vertex) -> @location(0) vec4f {
  let x=clamp(v.local.x,0.0,v.len);let d=length(vec2f(v.local.x-x,v.local.y))-v.halfW;
  let a=clamp(.5-d,0.0,1.0)*v.color.a;if(a<=0){discard;}return vec4f(v.color.rgb*a,a);
}`;
