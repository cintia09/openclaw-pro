# Test 目录约定

- 所有测试脚本统一放在 `clawnook/test/`。
- 顶层临时测试脚本已归档到 `clawnook/test/tmp/`。
- 所有本地测试日志统一输出到 `clawnook/test/logs/`。
- 所有本地测试临时文件统一使用 `clawnook/test/.tmp/`（由脚本自动创建）。
- 远端主机上的临时路径（例如 `/tmp/...`）仅用于远程执行过程，不作为本地测试产物保存位置。
