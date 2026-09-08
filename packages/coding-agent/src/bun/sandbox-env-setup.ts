import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

// 在执行会于启动阶段读取环境的模块前恢复环境。
restoreSandboxEnv();
