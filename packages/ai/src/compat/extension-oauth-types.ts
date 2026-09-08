import type { OAuthCredentials } from "../auth/types.ts";

/** 旧版扩展 OAuth 提示。 */
export interface OAuthPrompt {
	message: string;
	placeholder?: string;
	allowEmpty?: boolean;
}

/** 旧版扩展 OAuth 授权链接。 */
export interface OAuthAuthInfo {
	url: string;
	instructions?: string;
}

/** 旧版扩展 OAuth 设备代码通知。 */
export interface OAuthDeviceCodeInfo {
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
}

export interface OAuthSelectOption {
	id: string;
	label: string;
}

export interface OAuthSelectPrompt {
	message: string;
	options: OAuthSelectOption[];
}

/** 仅为 coding-agent 扩展兼容性保留的回调接口。 */
export interface OAuthLoginCallbacks {
	onAuth(info: OAuthAuthInfo): void;
	onDeviceCode(info: OAuthDeviceCodeInfo): void;
	onPrompt(prompt: OAuthPrompt): Promise<string>;
	onProgress?(message: string): void;
	onManualCodeInput?(): Promise<string>;
	onSelect(prompt: OAuthSelectPrompt): Promise<string | undefined>;
	signal?: AbortSignal;
}

export type { OAuthCredentials };
