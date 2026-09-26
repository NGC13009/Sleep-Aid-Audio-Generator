# 噪声模拟器 - 助眠音频发生器

[中文](README_CN.md)
[EN](README.md)

一个纯前端的噪声模拟器：在浏览器里实时合成白噪声、粉红噪声、布朗噪声，以及雨声、海浪、风声等自然 / 环境声音，并支持自定义功率谱与整夜锁屏播放。

无需构建、无需依赖、无需后端。把噪声看成一个广义平稳随机过程，为其指定功率谱密度后由随机相位逆傅里叶变换合成，因此生成的音频天然周期无缝、可无限循环。

点击下方链接立刻体验：

[Simulator - Sleep Aid Audio Generator](https://ngc13009.github.io/Sleep-Aid-Audio-Generator/)

[TOC]

## 快速开始

可[通过本站体验](https://ngc13009.github.io/Sleep-Aid-Audio-Generator/)。

或者下载源代码自部署：直接用浏览器打开 `index.html`（也可用任意静态服务器托管）。

基本使用：

1. 在「预设噪声选项」中点击若干噪声使其亮绿灯（默认已选中粉红噪声）。
2. 点击 **▶ 实时试听** 即时试听与调参；需要整夜播放时点击 **🌙 进入睡眠模式**，确认出声后直接锁屏即可。
3. 可用「⬇ 导出当前混音 WAV」把当前混音存成本地文件，离线循环播放，彻底不受浏览器限制。

## 详细说明

### 界面构成

页面分为三张卡片：

- **播放器控制面板**：实时试听 / 睡眠模式切换、总音量、睡眠定时、状态指示（引擎、屏幕唤醒锁、页面可见性、系统媒体控制、已播放时长）、WAV 导出，以及整夜使用与权限指南。
- **功率谱设计 / 查看器**：显示当前选中预设的实时频谱（试听模式下为实时柱状均衡器），自定义预设可拖动圆点编辑平滑功率谱曲线，并选择基础采样率与循环长度。
- **预设噪声选项**：按「基础噪声 / 自然声音 / 环境声音 / 自定义」分组。点击选中并加入混音（左侧亮绿色竖线），每个预设可单独调节音量（滑杆、数字输入或滚轮微调）。

### 噪声类型

| 分类 | 预设 |
| --- | --- |
| 基础噪声 | 白噪声、粉红噪声、布朗噪声 |
| 自然声音 | 小雨、大雨、远雷雨、海浪、风声、树叶沙沙 |
| 环境声音 | 风扇、空调、吹风机、机舱 |
| 自定义 | 可自由编辑功率谱曲线的随机过程，可增删多个 |

### 两种播放引擎

- **实时试听（RT）**：全部运行在 Web Audio 的音频线程，逐层用 `AudioBufferSourceNode.loop` 无缝循环，主线程只负责 UI；参数改动即时生效。切后台 / 锁屏时可能被系统挂起。
- **睡眠模式（Sleep）**：先把当前混音整体渲染为一段 PCM，再用单个 `AudioBufferSourceNode.loop` 做**样本级无缝循环**。同时挂一个隐藏 `<audio>` 媒体元素（经 Web Audio 以 0 增益接入、静音）作为媒体会话锚点，注册锁屏 / 系统播放控件并降低标签被回收的概率。若系统仍挂起 `AudioContext`，会自动回退到原生 `<audio loop>`（可出声，但循环点约 20–80ms 缝隙）。

实时试听期间若页面切后台，会自动切换到睡眠引擎。

### 其他能力

- **夜间模式**：一键深色主题，可随设置持久化。
- **睡眠定时**：到点淡出并停止；默认「关闭」即整夜播放。
- **屏幕唤醒锁（Wake Lock）**：亮屏时自动申请，防止自动熄屏；不支持时不影响睡眠模式。
- **设置持久化**：所有按钮、选项、音量、频谱、折叠状态等写入 Cookie（保留 90 天），下次打开自动恢复。

## 系统架构说明

| 文件 | 说明 |
| --- | --- |
| `index.html` | 页面结构：三张卡片 + 隐藏 `<audio>` 播放元素 |
| `style.css` | 全部样式（含夜间模式变量、多列响应式布局） |
| `script.js` | 全部逻辑，自上而下分为若干区块 |

`script.js` 的主要区块：

| 模块 | 说明 |
| --- | --- |
| 工具 | DOM/Toast/状态文案/计时格式化 |
| DSP 核心 | FFT、随机相位谱合成、滤波、包络、控制点插值 |
| 噪声类型注册表 | NOISES 对象，每种噪声一个 gen(params, preset) |
| 状态与持久化 | state、预设增删改、Cookie 读写 |
| 渲染参数 / 缓存 | renderParams、layerCache（按预设+参数缓存单层缓冲） |
| 混音渲染 | 睡眠模式 / 导出用的整段 PCM 渲染与 WAV 编码 |
| 实时引擎 | AudioContext、masterGain、每层 AudioBufferSourceNode |
| 睡眠引擎 | Web Audio 无缝循环、媒体会话锚点、原生回退 |
| Wake Lock / 定时 | requestWakeLock、ticker 淡出 |
| 可视化 | 功率谱曲线 + 实时均衡器柱状绘制、控制点拖拽 |
| UI 与初始化 | 预设行构建、状态刷新、事件绑定、卡片折叠 |

数据流：`预设列表 → layerBuffer()（调用 gen，归一化 RMS/峰值）→ 单层缓存 → 混音（RT 逐层叠加；Sleep 渲染整段）→ 输出（Web Audio / WAV）`。

### 随机相位功率谱合成

核心函数 `synthPeriodic(N, rate, ampFn)`：

1. 在频域构造长度为 \(N\) 的复数数组，对每个频点 \(k\)，由 \(\operatorname{ampFn}(f)\) 得到幅值 \(a\)，赋予随机相位 \(\varphi\)，即
   \[
   X[k]=a_k e^{j\varphi_k},\qquad j=\sqrt{-1}.
   \]

2. 填入共轭对称的一对 \(\operatorname{re}[k]/\operatorname{im}[k]\) 与 \(\operatorname{re}[N-k]/\operatorname{im}[N-k]\)，满足
   \[
   \operatorname{re}[N-k]=\operatorname{re}[k],\qquad
   \operatorname{im}[N-k]=-\operatorname{im}[k],
   \]
   从而保证逆变换结果为实信号：
   \[
   x[n]=\operatorname{IFFT}\{X[k]\}\in\mathbb{R}.
   \]

3. 调用自实现的迭代 FFT（`fftCore`）做逆变换，得到具有指定功率谱的近似高斯随机过程样本。

由于频谱离散且闭合，结果天然以 \(N\) 为周期，循环边界完全连续：
\[
x[n+N]=x[n].
\]
并且
\[
N=\operatorname{nextPow2}(\mathrm{loopSec}\times \mathrm{rate}),
\]
因此实际循环长度只能成倍跳；下拉里显示的秒数为近似值，`#loopInfo` 会给出真实长度）。

### 控制点插值

自定义谱用 \([f,\mathrm{dB}]\) 控制点在**对数频率域**上做单调三次插值
自定义谱用 `[f, dB]` 控制点在**对数频率域**上做单调三次插值（PCHIP，`makeSmoothDb`），避免过冲；`pointsToAmp` 再把相对 dB 转成幅值。若幅值为 \(a\)，则对应关系为
\[
\mathrm{dB}=20\log_{10}a
\quad\Longleftrightarrow\quad
a=10^{\mathrm{dB}/20}.
\]

### 滤波与自然声音

`lp1 / hp1 / lp1mod` 为一阶低通 / 高通（双遍处理以消除起始暂态，保证循环边界连续），`slowNoise` 生成低频带限慢包络，`addBursts` 叠加随机脉冲簇（雨滴、雷声），`humTones` 叠加对齐到 FFT bin 的正弦谐波（风扇、空调嗡鸣）。各自然 / 环境预设在此基础上组合出慢涨落、阵风、浪涌等特征。

## 开发说明

- **零构建**：无需 Node/npm，直接编辑 `index.html`、`style.css`、`script.js` 即可，浏览器刷新即生效。
- **无外部依赖**：FFT、WAV 编码、PCHIP、绘图全部手写实现，不引入任何库。
- **浏览器要求**：支持 Web Audio、Wake Lock 的现代浏览器（Chrome / Edge / Safari 等）。部分能力（Wake Lock、MediaSession）在隐私模式或旧浏览器可能不可用，代码中均已做降级处理。
- **注意事项**：音频播放必须由用户手势触发；`createMediaElementSource` 对同一元素只能调用一次；睡眠模式必须保持 `AudioContext` 处于 running，不能靠 `suspend()` 省电。更多音频引擎细节与踩坑见 [`.agents/音频播放与无缝循环说明.md`](.agents/音频播放与无缝循环说明.md)。
- **测试**：项目为单页演示，目前无自动化测试；改动音频引擎后建议手动验证「实时 / 睡眠 / 锁屏切换 / 导出」四条路径。

## 作者信息

[NGC13009](https://github.com/NGC13009)

[limitless © Copyright 2021~2026 All rights reserved](https://limitless.net.cn)

"Noise Simulator - Sleep Aid Audio Generator" open-source license: [GPLv3](https://www.gnu.org/licenses/quick-guide-gplv3.html)

[Limitless Blog](https://limitless.net.cn/?p=4743) 上的本项目介绍以及体验链接。
