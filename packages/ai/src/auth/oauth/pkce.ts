/**
 * 使用 Web Crypto API 的 PKCE 工具。
 * 同时适用于 Node.js 20+ 和浏览器。
 */

/**
 * 将字节编码为 base64url 字符串。
 */
function base64urlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * 生成 PKCE 代码验证器和质询值。
 * 使用 Web Crypto API 实现跨平台兼容。
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
	// 生成随机验证器
	const verifierBytes = new Uint8Array(32);
	crypto.getRandomValues(verifierBytes);
	const verifier = base64urlEncode(verifierBytes);

	// 计算 SHA-256 质询值
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const challenge = base64urlEncode(new Uint8Array(hashBuffer));

	return { verifier, challenge };
}
