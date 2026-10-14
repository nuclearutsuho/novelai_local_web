# braces 本地安全补丁

保留 braces 3.0.3 的 API、MIT 许可及 fill-range 依赖。针对 GHSA-vfj7-8cjw-p6xm，运行时五个文件（compile、constants、expand、parse、stringify）的深度防护回移自 https://github.com/micromatch/braces/pull/72 的固定提交 28d440b5dd449dbf1fe6f3506cf94ecca4d02660，其余运行时文件来自 npm braces 3.0.3。

此 PR 尚未合并，上游维护者对漏洞认定有异议；本项目自行承担此补丁维护，不将其称为官方修复版本。补丁限制括号和 AST 嵌套深度为 100，保留更严格的 maxDepth，阻止循环 parent 链，并包含 escapeInvalid 兼容性修复。正常 glob 语义不变。

package.json overrides 使全部依赖加载此本地实现。npm audit 不评估本地源码，因此审计通过不能代替对该补丁的代码审查和深度回归验证；没有忽略 advisory 或降低 CI 的 audit 级别。上游发布已修复版本后，应移除此副本并恢复 registry 依赖。

为保持 3.0.3 兼容，未引入该 PR 基线中与安全无关的引号解析和 block.invalid 变更；保留原 10000 字符长度限制。包版本使用 3.0.3-idlecloud.1，仅移除上游开发脚本和开发依赖，避免安装无关的旧测试工具。

一次性验证：真实 micromatch/chokidar 解析到本地实现；四个公开入口的括号深度 100 通过、101 拒绝；800 次 8001 字符深层输入均返回深度错误，最终回移版本合计 83 ms；另验证超深 AST、循环 parent、分数 maxDepth、escapeInvalid 与常规 glob/micromatch。该结果仅覆盖所列漏洞场景，不宣称本地包已被 registry audit 扫描。


漏洞前后对照：同一 9981 字符、4990 层花括号输入，npm 原版 compile 抛出 Maximum call stack size exceeded（23 ms），本地补丁在第 101 层抛出明确深度错误（1 ms）。本机 Node 22.14.0；npm ci、135 项现有测试、lint（0 error、1 个原有 img warning）、Next 15.5.27 静态构建均通过。npm audit --audit-level=high 退出 0，剩余 3 项 moderate 来自 postcss-selector-parser / postcss-nested / tailwindcss。
