export const EVALUATION_RPC_VERSION = 1 as const;
export const EVALUATION_RPC_OPERATIONS = [
	"eval.packs",
	"eval.scenarios",
	"eval.inspect",
	"eval.validate",
	"eval.run",
	"eval.cancel",
	"eval.status",
	"eval.results",
	"eval.report",
	"eval.compare",
	"eval.replay",
	"eval.rescore",
	"eval.stability",
	"eval.baselines",
	"eval.baselinePromote",
	"eval.gateCheck",
	"eval.gateExplain",
	"eval.failures",
	"eval.prunePreview",
] as const;

export type EvaluationRpcOperation = (typeof EVALUATION_RPC_OPERATIONS)[number];

export interface EvaluationRpcRequest {
	version: typeof EVALUATION_RPC_VERSION;
	requestId: string;
	operation: EvaluationRpcOperation;
	parameters?: Record<string, string | number | boolean | string[]>;
}

export interface EvaluationRpcError {
	code: "INVALID_REQUEST" | "UNSUPPORTED_OPERATION" | "NOT_FOUND" | "INTERNAL_ERROR";
	message: string;
}

export function validateEvaluationRpcRequest(request: unknown): EvaluationRpcError | undefined {
	if (!request || typeof request !== "object")
		return { code: "INVALID_REQUEST", message: "request must be an object" };
	const candidate = request as Partial<EvaluationRpcRequest>;
	if (candidate.version !== EVALUATION_RPC_VERSION || typeof candidate.requestId !== "string")
		return { code: "INVALID_REQUEST", message: "version and requestId are required" };
	if (!EVALUATION_RPC_OPERATIONS.includes(candidate.operation as EvaluationRpcOperation))
		return {
			code: "UNSUPPORTED_OPERATION",
			message: `unsupported evaluation operation: ${String(candidate.operation)}`,
		};
	return undefined;
}
