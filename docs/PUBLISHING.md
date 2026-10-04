# 发布 Strata Coder

目标源码仓库：`huyinghuan/strata-coder`。目标 npm 包：`strata-coder`。GitHub 用于保存源码与运行 Actions；包发布到 **registry.npmjs.org**，不是 GitHub Packages。

## 首次发布

1. 创建公开 GitHub 仓库，推送已检查的源码。不要上传本机配置、任务状态、reports 或凭据。
2. 确认 `package.json` 的 name、version、repository、license 正确。首次发布预定版本为 `0.1.0`；包名可用性以 registry 实际接受为准。
3. 在仓库执行：

```bash
npm ci --ignore-scripts
npm test
npm run test:package
npm pack --dry-run
npm login --registry=https://registry.npmjs.org/
npm whoami --registry=https://registry.npmjs.org/
npm publish --access public
```

登录、2FA 或设备确认在本人浏览器/终端完成，不要将 token、密码或恢复码写入仓库。首次包不存在时，先通过本地认证发布，再在包设置中配置 Trusted Publisher。若包名被占用，先统一修改 package.json、lockfile、文档与客户端启动参数，或选用本人 npm scope。

## 后续通过 GitHub Actions 发布

npm 的包 Settings → Trusted Publisher 中选择 GitHub Actions，并填写：

- Organization or user：`huyinghuan`
- Repository：`strata-coder`
- Workflow filename：`publish.yml`
- Environment name：留空（当前 workflow 未配置 environment）
- Allowed actions：允许直接 Publish，以匹配工作流中的 `npm publish`

工作流使用 GitHub-hosted runner、Node 24 和 npm OIDC，无需保存长期 `NPM_TOKEN`。npm 要求 CLI 至少 11.5.1；流程会检查版本。

后续版本更新示例：

```bash
npm version patch
git push origin main --follow-tags
```

然后在 GitHub 创建并发布相应 tag 的 Release（例如 `v0.1.1`），触发 `.github/workflows/publish.yml`。工作流验证 Release tag 与 package.json 版本一致，运行测试和 tarball 安装检查，再执行 `npm publish --access public`。草稿和 prerelease 不发布。每次发布使用新版本号，不能覆盖已经发布的版本。

若首次 `0.1.0` 已手动发布，再创建 `v0.1.0` Release 时，工作流会检查 registry 并跳过已存在版本，不会重新发布。

配置可信发布方是一次独立的账号设置，单纯提交 workflow 文件并不意味着已完成设置或发布。遇到 E404 / authentication 错误，核对 owner、repo、workflow 文件名和允许动作，并确认包的 repository URL 与 GitHub 仓库一致。

官方参考：[npm Trusted Publishers](https://docs.npmjs.com/trusted-publishers/)、[npm package.json](https://docs.npmjs.com/cli/configuring-npm/package-json/)。
