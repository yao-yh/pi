import chalk from "chalk";

const emittedDeprecationWarnings = new Set<string>();

export function warnDeprecation(message: string): void {
	if (emittedDeprecationWarnings.has(message)) return;
	emittedDeprecationWarnings.add(message);
	console.warn(chalk.yellow(`Deprecation warning: ${message}`));
}

/** 清除弃用警告状态。为测试而导出。 */
export function clearDeprecationWarningsForTests(): void {
	emittedDeprecationWarnings.clear();
}
