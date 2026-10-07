[English](README.md) | **简体中文**

# I'm Upping My P(doom) — 音乐视频

一支完全由代码渲染的生成式音乐视频，歌词以卡拉 OK 的方式逐词同步。每一帧都是歌曲时间的确定性函数，浏览器预览和离线 60 fps 导出运行的是同一套场景代码。

**在线观看：https://pdoom.ahdiua.com/** —— 整支视频由你的浏览器实时渲染，支持 1080p 和 4K。

> **本仓库是 [mexicat/pdoom-video](https://github.com/mexicat/pdoom-video) 的分支（fork）**，目标是让浏览器预览真正做到实时：预览性能优化、自适应 3D 细节、启动时着色器预热、交互式控制、实验性的 HDR 通路以及无损音频处理。详见[本分支的改动](#本分支的改动)。

> 本文是 [英文版 README](README.md) 的中文翻译，内容以英文版为准。`docs/` 下的文档目前只有英文。

这支视频是在 Claude Code 中与 Claude（Opus 5.5）协作完成的：概念与视觉方案、歌词对齐与音频分析、渲染器、每一个场景以及最终渲染，都是在与 Claude 的对话中做出来的。歌曲并非我们的作品，词曲与制作者见[致谢](#致谢)。

## 目录

- [观看](#观看)
- [快速开始](#快速开始)
- [预览](#预览)
- [渲染视频](#渲染视频)
- [本分支的改动](#本分支的改动)
- [检查](#检查)
- [仓库结构](#仓库结构)
- [部署](#部署)
- [重新生成时间数据](#重新生成时间数据)
- [致谢](#致谢)
- [许可证](#许可证)

更多文档（英文）：

| 文档 | 内容 |
|---|---|
| [`docs/TREATMENT.md`](docs/TREATMENT.md) | 创作概念、风格规范（调色板、字体、卡拉 OK 规则），以及每个场景画的是什么、表达什么 |
| [`docs/ENGINE.md`](docs/ENGINE.md) | 引擎与场景 API、4K 缩放规则、运动模糊采样、性能测量数据 |
| [`docs/WEBGPU.md`](docs/WEBGPU.md) | 已冻结的原生 WebGPU 实验及其结论 |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | 线上站点的构建与部署方式 |

## 观看

| 途径 | 说明 |
|---|---|
| **在线，直接在浏览器里：** https://pdoom.ahdiua.com/ | 当前代码，由你的 GPU 实时渲染。桌面和手机均可使用；按 `r` 切换 1080p / 2160p，在 HDR 显示器上可用 **HDR** 按钮开启实验性的 HDR 调色。下文所有[快捷键](#控制)和 [URL 参数](#url-参数)在线上同样有效，例如 https://pdoom.ahdiua.com/?t=100 会从回形针（paperclips）场景开始。 |
| **YouTube，4K：** https://www.youtube.com/watch?v=5EoO5413dBY | 较早的一次渲染。它的运动模糊每帧只平均 4 个子帧，快速运动会出现阶梯状重影，而且 YouTube 的压缩会把胶片颗粒抹糊。 |
| **本地渲染** | 效果最好：当前代码会在运动需要时为每帧采样多达 324 个子帧。见[渲染视频](#渲染视频)。 |

第一次打开线上站点时会显示几秒钟的 **Preparing preview**（准备预览）画面，用于编译着色器；之后再访问通常会更快，因为浏览器会缓存它们。

## 快速开始

环境要求：

- [bun](https://bun.sh) —— 预览只需要它。
- Google Chrome，以及 `PATH` 中带 libx264 的 ffmpeg —— 用于离线渲染（渲染器通过 playwright-core 以无头模式驱动 Chrome）和浏览器检查。
- [uv](https://docs.astral.sh/uv/) —— 只有重新生成时间数据的分析工具才需要。

```sh
cd app
bun install
bunx vite
```

打开 http://localhost:5173 。`?t=23` 从指定时间开始，`&scale=2` 以 4K 渲染。

## 预览

本节内容同时适用于本地预览和[线上站点](https://pdoom.ahdiua.com/)。

### 控制

| 按键 | 功能 |
|---|---|
| 空格 | 播放 / 暂停（焦点在按钮或进度条上时同样有效） |
| ← / → | 快退 / 快进 1 秒（按住 shift 为 5 秒） |
| `,` / `.` | 逐帧步进 |
| `[` / `]` | 上一个 / 下一个场景 |
| `l` | 循环播放当前场景 |
| `h` | 隐藏界面，画面会占满腾出的空间 |
| `r` | 切换 1080p / 2160p |
| `q` | 循环切换 3D 细节：Auto / Full / Performance |
| `f` | 进入 / 退出全屏 |
| `b` | 开关场景运动模糊 |
| `g` | 开关胶片颗粒 |

控制栏上有同样功能的按钮：播放、分辨率（同时显示当前值和目标值，例如 `1080p (Switch to 2160p)`）、3D 细节、运动模糊、胶片颗粒、HDR，以及靠右的全屏按钮。

- **切换分辨率**会以所选的物理分辨率重建页面，并保留播放位置、循环和效果设置。浏览器允许时会自动恢复播放；全屏需要重新进入。
- **运动模糊和胶片颗粒在预览中默认关闭**，以减轻播放负担；该选择在当前标签页会话内跨分辨率切换保留。这里的运动模糊指场景自带的镜头 / 数字 / 几何体拖影，预览仍然只用一个时间采样。导出时的多采样运动模糊由 `--samples` / `--shutter` 单独控制，不受预览设置影响。
- **暂停时**只有在跳转、调整窗口大小或修改设置时才会重绘。

### URL 参数

| 参数 | 作用 |
|---|---|
| `t=85` | 从该歌曲时间（秒）开始 |
| `scale=2` | 以 3840×2160 而不是 1920×1080 渲染 |
| `loop=1` | 循环播放 `t` 所在的场景 |
| `detail=full` / `detail=performance` | 为这个链接指定 3D 细节档位 |
| `hdr=1` | 开启 HDR 预览（`hdr-headroom`、`hdr-gamut`、`hdr-hue`、`hdr-glow` 对应它的各个滑块） |
| `only=leftturn,prompt3` | 只加载这些时间线条目（开发用） |
| `warmup=0` | 跳过启动时的着色器准备（开发、冷启动性能分析用） |

### 启动准备

播放之前，**Preparing preview** 画面会异步编译着色器，并在离屏状态下渲染有代表性的帧。这样，首次使用着色器、纹理和缓冲区造成的卡顿（尤其是 Shoggoth 和回形针场景）就被挪到了启动阶段，而不会出现在歌曲中途。准备完成后进度条消失，请求的起始时间保持不变。切换分辨率后会针对新分辨率重新准备。离线导出会自动跳过这一步。

### 3D 细节

Shoggoth、回形针（paperclips）和 Ilya 的房间包含开销很大的光线步进（raymarching）着色器。点击 **3D detail** 或按 `q` 循环切换：

- **Auto**（默认）—— 用 GPU 计时器测量这些渲染通道；某个通道超过 10 ms 时会降低它的内部分辨率，目标约为 7.5 ms，并且缓慢恢复以避免来回振荡。最低细节为：回形针 / Ilya 540p，Shoggoth 的几何缓冲 270p。没有 GPU 计时器的浏览器会让触屏设备以降低后的细节起步，持续播放缓慢时还会进一步降低。
- **Full** —— 原始内部分辨率，以及与导出相同的步进次数。
- **Performance** —— 回形针 / Ilya 的 3D 背景以 720p 渲染；Shoggoth 使用 360p 的几何缓冲。精细几何会变柔，但歌词、叠加层、粒子、Shoggoth 的解析式眼睛 / 面具以及输出分辨率都保持原生。

该设置在重新加载后保留。SDR 和 HDR 离线导出始终使用完整细节；HDR 预览可以使用任意档位。

### 手机

隐藏的控件可以通过悬浮的 **Show controls** 按钮或点击画面恢复；显示控件不会暂停播放。全屏时会在支持的情况下请求横屏；否则播放器使用旋转后的横向布局，直到设备本身旋转。不支持页面全屏的浏览器会在浏览器窗口内使用**扩展视图**，因此浏览器工具栏可能仍然可见。全屏 / 扩展视图按钮用于退出该模式并释放方向锁定。

### 实验性 HDR 预览

**HDR** 按钮（或 `?hdr=1`）会启用一个实验性的显示桥接：场景仍然用 WebGL 渲染，再由一个很小的 WebGPU 通道把浮点输出通过扩展动态范围的 canvas 呈现出来。切换时会在当前播放位置重新加载。它需要 HTTPS 或 localhost、WebGPU、浮点 WebGL 绘图缓冲，以及报告 `(dynamic-range: high)` 的浏览器。不支持的配置和 GPU 设备丢失都会回退到 SDR。默认预览和默认导出仍然是 SDR；HDR 视频导出有单独的 `--hdr` 选项（见[下文](#hdr-导出)）。

HDR 调色就是把 SDR 调色的上限抬高：在色调肩部的拐点以下完全一致，之后平滑地过渡到显示器的 headroom，而不是参考白。炽热的橙色保持色相而不会偏黄，辉光略微收敛，画面以 **Display-P3** 输出：平涂的颜色（比如一个橙色的词）保持它在 SDR 中的颜色，只有高于参考白的光，也就是辉光，才会变成 sRGB 无法显示的更纯的橙色。预览和导出共用默认值：峰值 1000 尼特、参考白 203 尼特，约为 **参考白的 4.93 倍**。

HDR 按钮旁会出现四个滑块，可实时调整调色，并且都会保存在 URL 中：

- **Headroom**（`?hdr-headroom=`）是显示器峰值亮度相对于其 SDR 白的倍数。浏览器不会报告这个值，超过真实值的部分都会被截断。**Test card**（测试卡）会显示 1× 到 10× SDR 白的方块，每个方块内有一个略暗的小方块：把 Headroom 设为还能看清内部小方块的最亮那一格。在 Chrome 中，`chrome://gpu` 把它列为 *HDR relative maximum luminance*；它取决于面板和系统的 SDR 亮度设置（400 尼特的显示器、SDR 白为 240 尼特时为 1.67）。
- **P3 glow**（`?hdr-gamut=`，默认 100%）决定辉光深入 Display-P3 的程度；0% 时所有颜色与 SDR 相同。请对着火花或引信来判断：太高时辉光会比旁边平涂的橙色更红、更像霓虹。
- **Hold hue**（`?hdr-hue=`，默认 60%）决定最热的橙色是什么颜色。0% 时火花的核心会随亮度升高而变黄，与 SDR 相同；100% 时保持调色板里的橙色。
- **Trim glow**（`?hdr-glow=`，默认 30%）去掉亮物体周围的一部分柔和光晕。如果火花旁的暗部显得发雾就调高，如果火花看起来像生硬的点就调低。

SDR 截图和对缓冲区的数值检查都无法确定 HDR 显示器实际呈现的亮度和颜色；请在显示器上亲眼判断调色。

诊断用：`?hdr=test` 即使在报告为 SDR 的显示器上也强制走 HDR 管线，`?hdr=bridge` 使用同一个桥接但采用 SDR 调色，以便单独测出传输开销。两者都会显示 **HDR: Test**，并不表示屏幕正在显示 HDR。

### 原生 WebGPU 实验（已冻结）

`/webgpu-preview.html?scale=2&t=100` 是回形针场景的一个独立的原生 WebGPU/WGSL 移植版。它以固定的 Full 预览质量渲染完整的场景和后期处理链，失败时回退到 WebGL 预览。做它是为了回答一个问题：原生移植会不会更快？前后测了两次。在测试机器上，重场景每帧的 GPU 时间少 3–10%，着色器准备时间只有三分之一到一半，但屏幕上的帧间隔最多只缩短百分之几，不足以更换渲染器。它现在处于**冻结**状态：只是一个保持可编译、用于对比的快照，不再与场景同步，WebGL 仍是唯一的渲染器。结果以及“冻结”的具体含义见[报告](docs/WEBGPU.md)。

## 渲染视频

```sh
cd app
bun scripts/render.ts video --samples auto --shutter 0.2 --out ../out/pdoom.mp4
```

- **输出：** 1920×1080、60 fps，x264 CRF 16。源 AAC 音频直接复制，不再经过一次有损编码。
- **运动模糊：** 每一帧都是在很短的快门时间内（`--shutter 0.2`，即帧时长的五分之一）分布的许多子帧的平均，因此快速运动留下的是连续的拖影，而不是几个阶梯状的重影。`--samples auto` 逐帧决定采样数：静止帧 12 个，普通镜头运动 36 个，甩镜、猛推和快速变焦 108 或 324 个。当继续增加子帧对画面的改变不超过 `--tol` 级（满级 255，默认 3）时即停止。`--samples N` 使用固定的 N（`--samples 4` 可以快速出草稿）。原理见 [`docs/ENGINE.md`](docs/ENGINE.md) 中的 “Motion blur and sampling”。
- **其他模式：** `stills`（静帧）、`sheet`（联系表，`--cuts` 覆盖每个场景切换点）、`perf`，以及 `plates`（重新生成 `public/plates/`，即片尾倒带蒙太奇使用的静帧；修改场景后需要重新运行）。

```sh
bun scripts/render.ts stills --t 85.3,86.0,87.3 --only leftturn --out ../out/wip/leftturn
bun scripts/render.ts sheet --from 85 --to 89 --n 16 --cols 4 --only leftturn --out ../out/wip/sheet.png
bun scripts/render.ts video --from 85 --to 89 --only leftturn --samples 4 --out ../out/wip/clip.mp4
```

`--only` 接受的是时间线条目 id（`prompt3`、`hook2` 等），不是模块名。`render.ts` 会复用 `--url`（默认 `http://localhost:5173`）上的开发服务器，否则自行启动一个不带热重载的私有服务器。

### 4K

```sh
cd app
bun scripts/render.ts video --scale 2 --samples auto --shutter 0.2 --x264 aq-mode=3:rc-lookahead=30 --out ../out/pdoom-4k.mp4
```

- **输出：** 真正的 3840×2160 渲染（不是放大）：每个图层、每条线、每个着色器都以物理分辨率渲染。场景按 1920×1080 逻辑像素布局，所以 4K 画面看起来和 1080p 一样，只是更锐利。
- **开销：** 受 GPU 限制。一帧耗时从约 40 ms（静止帧）到超过 10 秒（108–324 个子帧的光线步进房间）不等。整首歌在 M5 Pro 上用了约 2.5 小时，分段在两条并行管线中渲染（`--from` / `--to`，然后无损拼接）。每条管线的无头 Chrome 约占 5 GB、ffmpeg 约占 4 GB；上面较短的 x264 lookahead 可以压低 ffmpeg 的内存占用。
- **编码：** 胶片颗粒按 4K 像素逐个渲染，编码代价很高：默认 CRF 16 时码率约 670 Mbit/s（整首歌 13 GB，是 1080p 文件的 8 倍），`--crf 18` 约 450 Mbit/s，`--crf 20` 约 230 Mbit/s。
- `--scale 2` 适用于所有模式。此时 `stills` 保存全分辨率 PNG，`perf` 测量 4K 帧时间。

### HDR 导出

使用 NVIDIA HEVC 编码器导出 4K HDR 视频：

```sh
bun scripts/render.ts video --hdr --codec hevc_nvenc --scale 2 --preset p6 --cq 18 --samples auto --shutter 0.2 --out ../out/pdoom-hdr.mp4 -- -spatial-aq 1 -aq-strength 8
```

- `--hdr` 输出 **10-bit PQ (ST 2084) / BT.2020** 视频。画面在调色全程保持浮点，然后打包成 16-bit PQ RGB 交给 FFmpeg，所以这不是把已经截断的 8-bit SDR 图像再拉伸。HDR 导出不需要 WebGPU、HDR 显示器，也不需要开启 Windows HDR。
- `--hdr` 同样适用于 `stills`：`bun scripts/render.ts stills --hdr --t 4.14,13 --out ../out/wip/hdr` 会写出标记为 PQ / BT.2020（`cICP` 块）的 16-bit PNG，调色与视频完全一致。Chrome 会把它们显示为 HDR；忽略该标记的看图软件会显示得又暗又平。`sheet` 保持 SDR。
- `--hdr-white 203` 设置参考白（尼特）；`--hdr-peak 1000` 设置调色上限。两者之比就是 headroom，默认值与预览一致。要导出在预览里调好的效果，把 `--hdr-peak` 设为 203 × 预览的 headroom，并照抄另外三个值。这些是母版制作目标，不是对你显示器的测量值。
- `--hdr-gamut 1`、`--hdr-hue 0.6` 和 `--hdr-glow 0.3` 对应预览里的 P3 glow、Hold hue 和 Trim glow 滑块（0 到 1）。颜色保持在 Display-P3 之内，装在 BT.2020 容器里传输。
- `--hdr-light auto`（默认）会在编码前用一次快速的单采样遍历测出 MaxCLL 和 MaxFALL，因为编码器需要事先知道它们。`--hdr-light nominal` 跳过这一遍，写入调色上限和未知的平均值；`--hdr-light 950,120` 直接提供已知数值。
- 母版元数据描述的是所选峰值下的标称 P3-D65 显示器，而不是实测的显示器。测得的光照水平来自单采样帧；运动模糊只会降低峰值，所以它们是编码后视频的上界。AAC 音频依然不经重新编码直接复制。

### 编码器与自定义 FFmpeg 选项

- 不指定 `--codec` 时，HDR 默认使用 CPU 的 `libx265`，SDR 默认使用 `libx264`。`--codec hevc_nvenc` 和 `--codec av1_nvenc` 在 GPU / 驱动 / FFmpeg 构建支持时使用 NVENC。NVENC 只加速编码；场景渲染、时间超采样和回读仍然需要时间。
- NVENC 默认预设 `p6`、VBR、CQ 18，可用 `--preset` 和 `--cq` 调整。x264 / x265 使用 `--crf`，常规 SDR / HDR 模式下默认分别为 16 / 18。`--x264` 和 `--x265` 接受编码器专用的参数字符串。
- HDR 需要带 `zscale` 和所选 10-bit 编码器的 FFmpeg 构建。支持 `-mastering_display` 和 `-content_light` 输入选项的构建还会把静态 HDR 元数据传给硬件编码器（已在 FFmpeg 9.0.2 上测试）。在较旧的构建上，x265 自行提供元数据；其他编码器保留 PQ / BT.2020 色彩标记，并打印缺少静态母版元数据的警告。
- 短片段的 HEVC NVENC、4K AV1 NVENC、x265 和 SDR 导出都已用 ffprobe 检查过。

`--` 之后的所有内容都会作为**逐个独立的输出参数**传给 FFmpeg，排在自动生成的默认参数之后。例如：

```sh
bun scripts/render.ts video --hdr --codec av1_nvenc --preset p5 --cq 20 --out ../out/pdoom-av1-hdr.mp4 -- -rc vbr -b:v 0 -spatial-aq 1
```

如果参数里含有空格，或者想在不同 shell 间复用，可以把一个 JSON 数组保存为 `encode-options.json`：

```json
["-rc", "vbr", "-cq", "20", "-b:v", "0", "-metadata", "comment=My HDR render"]
```

然后传入 `--ffmpeg-args-file encode-options.json`。`--` 之后的参数优先于文件中的参数。参数字符串不会经过 shell 执行。用 `--ffmpeg /path/to/ffmpeg` 选择自定义的可执行文件，用 `--print-ffmpeg` 查看完整的命令数组。请通过 `--codec` 选择编码器，这样生成的默认参数才与之匹配；覆盖 `-vf` 或 `-pix_fmt` 也会替换掉默认的 HDR 色彩转换 / 位深设置。无效的 FFmpeg 选项会明确报错，而不会让渲染器无限等待。

## 本分支的改动

上游的导出效果很漂亮，但它的预览会在首次使用着色器时卡顿，而且暂停时仍在运行沉重的 GPU 通道。本分支让**浏览器预览真正实时**、用起来顺手，[线上站点](https://pdoom.ahdiua.com/)也正是因此才成为可能。这些仅用于预览的优化不会改变导出结果。

| 方面 | 改动 |
|---|---|
| 预览性能 | canvas 纹理的 GPU sRGB 转换缓存、空间采样由四次减为一次、静态几何预烘焙、暂停时不重绘 |
| 自适应 3D 细节 | 三个光线步进场景在较慢的 GPU 上降低内部分辨率（见 [3D 细节](#3d-细节)） |
| 着色器预热 | 首次编译挪到启动画面；光线步进着色器的编译时间大幅缩短 |
| 控制 | 分辨率、全屏、3D 细节、运动模糊和颗粒的快捷键与控制栏；手机布局（见[控制](#控制)） |
| HDR | 实验性 HDR 预览和 10-bit PQ 导出（[预览](#实验性-hdr-预览)、[导出](#hdr-导出)） |
| 音频 | AAC 音轨不经重新编码直接复制进 MP4 |
| 检查 | `bun run check`：一条命令完成类型检查和全部浏览器回归检查（见[检查](#检查)） |
| 部署 | 每次推送到 `main` 都会构建并发布到 https://pdoom.ahdiua.com/ （见[部署](#部署)） |

### 预览性能

最大的瓶颈是在 Chrome / ANGLE D3D11 下把 Canvas2D 纹理上传为 `SRGB8_ALPHA8`，连空的 HUD 也不例外。

| 技术 | 说明 |
|---|---|
| **GPU sRGB 转换缓存** | `FSPass` 把每个 canvas 纹理以 RGBA8 上传一次，再用一个着色器通道解码到半浮点线性渲染目标，之后才进行过滤和 mipmap 生成。未变化的纹理和空 HUD 会被复用；销毁和上下文恢复会使缓存失效 |
| **预览中单次空间采样** | 导出时采 4 个旋转网格采样点（`SS_TAP`）的着色器，在预览中只采 1 个居中采样点，以少量边缘平滑换取速度 |
| **静态几何预烘焙** | loss 地形的顶点高度在 `init()` 中计算一次，而不是每帧计算 |
| **暂停时抑制重绘** | 暂停的预览跳过 `requestAnimationFrame` 绘制，除非用户跳转、调整大小，或 WebGL 上下文恢复 |

测试环境：Windows Chrome 154、RTX 4070 SUPER，真实 3840×2160，开启颗粒和模糊：

| 场景 | 原始 GPU 毫秒/帧 | 优化后 GPU 毫秒/帧 |
|---|---:|---:|
| loss 图表（10.64 s） | 173.5 | 0.6 |
| loss 地形（13 s） | 185.9 | 1.5 |
| 回形针俯视（98 s） | 191.1 | 1.5 |
| 回形针晶格（100 s） | 198.8 | 12.5 |
| 回形针天花板（101 s） | 221.9 | 15.8 |

更多测量数据和图像回归方法见 [Preview performance validation](docs/ENGINE.md#preview-performance-validation)。

### 自适应 3D 细节

在 Auto 档位下，异步 GPU 计时器测量这些昂贵的通道；启动期间，三个昂贵的场景会重复渲染已初始化的帧，以便在播放前测出稳态 GPU 开销（初次分配和首次使用时的驱动工作不计入这次校准）。7.5 ms 的目标为合成和后期处理留出了时间：稳定的帧率比 3D 分辨率的最后一档更能让人感觉到“画质好”。

在 Auto 和 Performance 档位下，回形针晶格的步进次数也由 128 降为 80，并且在第三层以下就停止，而不是第五层。省下的步数原本花在已经深入雾中的掠射光线上，去掉的那些层亮度至多只有八分之一，而且只能透过缝隙看到，所以肉眼看画面相同，开销却低 5–16%（4K，RTX 4070 SUPER）。缩短它的接触阴影也试过，但被否决了：光会从天花板下漏出来。Shoggoth 没有这样的余量：它的开销在于穿过 25 个图元的主步进，减少步数或加大步长，在省下 3% 之前就已经看得出来了。

着色器在完整细节下也避免了多余的工作：Shoggoth 只在光线最终命中点计算雕刻坐标，已完成的回形针使用不含三角函数的解析最近点，Ilya 跳过未被照亮的雾气采样以及对自发光屏幕不必要的着色。

**Full 与 Performance 对比**，Chrome / RTX 4070 SUPER，1080p，12 帧预热后测量 30 帧的整帧 GPU 时间中位数（`preview-perf.ts --preview --detail full|performance`）：

| 场景 / 时间 | Full | Performance |
|---|---:|---:|
| Shoggoth（34 s） | 2.27 ms | 1.51 ms |
| 回形针（100 s） | 5.17 ms | 2.37 ms |
| 回形针天花板（101 s） | 6.33 ms | 3.45 ms |
| Ilya 的房间（133 s） | 4.12 ms | 1.73 ms |

这些桌面端的测量值并不能用来预测手机 / 核显的帧率。`detail-check.ts` 另外测试了：用模拟的查询开销检验慢 GPU 下的自适应、无计时器时的触屏回退、可逆的画质切换、不产生新的着色器编译，以及导出像素不变。

### 着色器预热

`Engine.warmup()` 在播放控件和音频启用之前运行。每个场景提供 `warmupTimes()` —— 默认是它的开头、中间和结尾；内部有短暂过渡的场景（回形针晶格、片尾倒带）会额外加入明确的时间点。对每个时间点，引擎会：

1. 让绘制调用经过 `WebGLRenderer.compileAsync`（保留真实的渲染目标、相机和材质）
2. 渲染一帧真实的离屏画面并等待 GPU fence，从而初始化纹理上传、几何缓冲和驱动管线
3. 更新进度条并让出事件循环，使加载画面保持响应

等待时间大部分花在光线步进着色器上，而它们的编译时间又大部分花在把同一个距离函数一遍又一遍地编译：每个法线采样一次、每个遮蔽采样一次、每一层一次。现在它们的循环从一个恒为零的 uniform（`ZERO`）开始，编译器无法将其展开，于是每个循环只编译一次该函数；回形针晶格也改写成了对两个堆叠和两层的循环。画面没有变化（回形针逐位相同；Shoggoth 和 Ilya 在舍入误差之内）。

测试机器上的冷启动准备时间（全新的 Chrome 配置文件、RTX 4070 SUPER、1080p）：

| | 之前 | 之后 |
|---|---:|---:|
| 整个准备过程 | 13.3 s | 7.4 s |
| 最长的单次卡顿 | 5.2 s | 1.6 s |
| 回形针 | 5.4 s | 1.2 s |
| Ilya 的房间（由最先展示它的 loom 场景首次编译） | 2.9 s | 1.7 s |
| Shoggoth | 1.4 s | 1.0 s |

Chrome 会缓存编译好的着色器，所以这是首次访问时的等待时间。测量数据、回形针晶格所做的取舍，以及尝试过但被否决的方案，见 [`docs/ENGINE.md`](docs/ENGINE.md#raymarcher-compile-time-and-preview-cost)。

### 无损 AAC 音频

导出管线把 `audio/pdoom.m4a` 中的 AAC 音轨直接复制进 MP4 容器，不重新编码，保留原始音质。该 M4A 是从提供的源 AAC 无损重新封装而来；多余的裸 AAC 文件没有保留在工作树中。

## 检查

项目没有单元测试套件，也没有 linter；工作成果通过渲染和浏览器回归检查来验证。在 `app/` 下：

```sh
bun run typecheck      # src/ 和 scripts/
bun run check          # 类型检查 + 全部浏览器检查，约三分钟
```

`bun run check` 会自行启动一个私有的预览服务器，并依次运行各项检查（需要 Chrome 和 GPU）。`--only hdr,detail` 和 `--skip preview` 用于选择检查项，`--list` 列出它们的名字。每个脚本也可以单独运行，针对 `PDOOM_URL`（默认 `http://127.0.0.1:5173`）上的服务器。推送之前请先运行它：部署只做类型检查，除此之外没有别的 CI。

| 脚本 | 用途 |
|---|---|
| `check.ts` | `bun run check` 背后的运行器 |
| `preview-check.ts` | 所有场景的中点和切换边界、两种效果设置、暂停渲染、颗粒、模糊、全屏、分辨率切换、播放位置 / 设置的保留 |
| `warmup-check.ts` | 1080p 和 2160p 下的着色器准备：就绪后的编译次数、进度报告、准备前后逐像素对比 |
| `detail-check.ts` | 自适应 3D 细节、慢 GPU 模拟、无计时器的触屏回退、原生细节的恢复、控件，以及与导出的隔离 |
| `mobile-check.ts` | 触屏视口：隐藏控件的恢复、横屏布局、方向锁定的回退、退出全屏 |
| `hdr-check.ts` | HDR 预览：最终输出中的高动态范围像素、画面朝向、实时 headroom 控制、回退行为 |
| `hdr-export-check.ts` | HDR 导出：PQ 参考电平、色域转换、16-bit 打包、调色曲线、测得的光照水平、1080p / 4K 下的自适应采样 |
| `determinism-check.ts` | 每个时间线条目在三个时间点上，无论是从很早之前、从上一帧，还是从歌曲更后面跳过来，得到的像素都相同 |
| `hdr-display-check.ts` | 在真实显示器上、可见窗口中检查 HDR 预览（`bun run check --only hdr-display`；在 SDR 显示器上会跳过） |

基准测试，不属于 `check`（GPU 基准测试请逐个运行，切勿并行）：

| 脚本 | 用途 |
|---|---|
| `preview-perf.ts` | 通过 `EXT_disjoint_timer_query_webgl2` 测量 GPU 帧时间；丢弃预热和 disjoint 的测量值，可捕获参考 PNG 用于图像回归，`--burst` 用于比较着色器变体 |
| `compile-perf.ts` | 每个场景的冷启动着色器准备时间（每次运行使用全新的浏览器配置文件），`--jobs` 用于较慢的步骤 |
| `hdr-perf.ts` | 预热后的 SDR / bridge / HDR 预览在 1080p 和 4K 下的对比 |

## 仓库结构

- `app/` —— 渲染器：TypeScript + three.js，bun + Vite。
  - `src/engine/` —— 渲染器核心：时间线播放、后期处理（bloom、halation、颗粒）、字体排印（Archivo、IBM Plex Mono、Cormorant Garamond、单线绘图仪字体）、GPU 线段批处理、HUD。
  - `src/scenes/` —— 每个场景一个模块（`open`、`loss`、`prompt`、`hook`、`room`、`shoggoth`、`spacetime`、`ascent`、`bureau`、`leftturn`、`paperclips`、`fuse`、`stack`、`dense`、`loom`、`ilya`、`outro`），外加共享的视觉母题。
  - `src/timeline.ts` —— 剪辑：场景窗口锚定在歌词行上，并吸附到节拍网格。
  - `src/webgpu/` —— 已冻结的 WebGPU 实验。
  - `scripts/render.ts` —— 离线渲染器（无头 Chrome → 通过 WebSocket 传输原始帧 → ffmpeg）。
  - `scripts/*-check.ts`、`scripts/*-perf.ts` —— 上文的检查和基准测试。
- `data/lyrics.json` —— 词级（部分为音节级）歌词时间。
- `data/audio.json` —— 速度（132.007 BPM）、节拍、强拍、段落、鼓 / 人声起音点和响度包络。
- `audio/pdoom.m4a` —— 播放 / 导出用的歌曲（Claude-Pop 版本，见致谢），从提供的源 AAC 无损重新封装，未重新编码。
- `audio/pdoom.mp3` —— 最初用于时间分析的参考音频。替换后的 AAC 时长相同，也没有测到对齐偏移，所以现有的歌词 / 节拍时间仍然有效。
- `lyrics/lyrics.src.js` —— 原始的行级歌词（时间为近似值）。
- `analysis/` —— 生成时间数据的 Python（uv）工具：Demucs 分轨、与 Whisper 交叉校验的 CTC 强制对齐、节拍 / 强拍 / 起音点分析。见 `analysis/align.py` 和 `analysis/analyze.py`。
- `docs/` —— 视觉方案、引擎指南、WebGPU 报告、部署说明。
- `out/` —— 渲染输出（不在仓库中）。

## 部署

线上地址是 https://pdoom.ahdiua.com/ ，一个由 Cloudflare 托管的静态 Vite 构建。Cloudflare 直接连接到 GitHub 仓库，每次推送到 `main` 都会自行构建并部署；构建设置保存在 Cloudflare 控制台里，而不在本仓库中。构建过程只做类型检查，所以推送前请先运行 `bun run check`。细节和手动部署命令见 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 重新生成时间数据

仓库中提交的 `data/*.json` 就是渲染器所需的全部数据。重新生成它们需要分轨音频和中间产物，这些不在仓库中：

- **分轨：** 用 Demucs `htdemucs_ft` 输出到 `analysis/stems/htdemucs_ft/pdoom/`（`uv run python -m demucs -n htdemucs_ft -o stems ../audio/pdoom.mp3`），再加上由 mel-band-roformer 卡拉 OK 模型（audio-separator）分离出的主唱，放在 `analysis/stems/karaoke/lead.wav`。
- **中间产物：** `ctc_emissions.py`、`whisper_run.py` 和 `vocal_feats.py` 会把它们写入 `analysis/work/`。整个流程在 `analysis/align.py` 的开头有说明。

```sh
cd analysis
uv run python align.py      # data/lyrics.json
uv run python analyze.py    # data/audio.json
```

这些模型会往 `analysis/.cache/` 下载约 4 GB 的权重；用完后请删除该文件夹。

## 致谢

- **原项目：** [mexicat/pdoom-video](https://github.com/mexicat/pdoom-video)，本仓库是它的分支。
- **歌曲：** “I'm Upping My P(doom)”。歌词由 [osmarks](https://docs.osmarks.net/hypha/p%28doom%29_song_objectively_correct_interpretation) 创作，基于 [MusicPerson](https://www.udio.com/creators/MusicPerson) 写的开头主歌和副歌，部分歌词来自 EleutherAI Discord 上的建议，片尾和最后一段副歌得到了 Claude 的帮助。原版用 Udio 生成，于 2024 年 11 月发布（[YouTube](https://www.youtube.com/watch?v=uEB5E67vcPA)）。本视频使用的是用 Suno 制作的 “Claude-Pop” 版本，由 [deckard (@slimer48484)](https://x.com/slimer48484/status/2097752569212756134) 于 2026 年 9 月发布。
- **字体：** Archivo、IBM Plex Mono 和 Cormorant Garamond（SIL Open Font License）。单线字体 EMS 和 Hershey 来自 `hersheytext` 包（OFL / 公有领域）。

## 许可证

代码以 [MIT 许可证](LICENSE) 发布。`app/public/fonts/` 中的字体保留各自的许可证（见致谢）；歌曲和歌词（`audio/`、`lyrics/`、`data/lyrics.json`）不在该许可证范围内，它们归各自的作者所有（见致谢）。
