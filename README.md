# StartLine 网球执裁台

面向平板、手机和电脑的独立网球模拟执裁工具。GitHub Pages 发布后，可直接打开：

**https://hej014519-web.github.io/tennis-umpire/**

无需登录，也不需要服务器账号。支持单打／双打、逐分计分、发球提示、手动球员站位、换边、旋转视角、暂停、撤销、判罚确认及比赛记录导出。使用的是可配置的模拟赛制，正式比赛应先核对主办方批准的规则。

## 记录与隐私

- 记录仅保存在当前设备的当前浏览器中，没有云同步，也不会同步到其他观众或裁判设备。
- 不请求定位，不包含真实赛事报名名单。默认姓名和比赛用于模拟体验。
- 新建比赛会替换当前本机记录；可先通过“导出”保存 JSON 备份。清理浏览器数据或更换浏览器后，本机记录不会自动恢复。
- GitHub Pages 托管的是静态程序。仓库源码、发布文件与个人设备上的比赛记录彼此独立。

## 本地运行

使用 Node.js 22.13 或更高版本。在项目目录安装依赖后启动：

```sh
npm install
npm run dev
```

检查与生成静态页面：

```sh
npm run test
npm run typecheck
npm run build
npm run preview
```

测试覆盖独立计分引擎。构建输出到 `docs/`，同时生成 `docs/.nojekyll`；所有发布资源使用相对路径，适配 GitHub 仓库子路径。依赖版本在 `package.json` 固定；已有 `package-lock.json` 时，复现安装可使用 `npm ci`。

主要目录：`src/` 是静态入口与兼容处理，`components/umpire/` 是裁判界面及互动球场，`lib/` 是计分引擎与本机存储适配，`tests/` 是计分测试。项目使用 Vite、React 和 TypeScript。

## 发布到 GitHub Pages

1. 将项目放入 `hej014519-web/tennis-umpire` 仓库，运行检查和 `npm run build`，把源码及生成的 `docs/` 一起提交到 `main` 分支。
2. 打开仓库 **Settings → Pages**，在 **Build and deployment** 中选择 **Deploy from a branch**。
3. 选择 **main** 分支和 **/docs** 目录，点击 **Save**，等待 GitHub 显示发布结果。
4. 打开上述 `github.io` 地址验证。后续更新重新构建并提交 `docs/` 即可。

如果仓库名称改变，请同步更新本页地址和 `index.html` 的 `og:url`。可以把发布地址发送到微信中打开；微信内的网络可达性、全屏支持和链接卡片展示取决于微信及网络环境，需在实际设备验证。
