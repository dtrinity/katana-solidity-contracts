import { Interface } from "@ethersproject/abi";

export const DEFAULT_MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const MULTICALL3_ABI = [
  "function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) public payable returns (tuple(bool success,bytes returnData)[] memory returnData)",
];

export interface MulticallRequest {
  readonly target: string;
  readonly callData: string;
  readonly allowFailure?: boolean;
}

export interface MulticallResult {
  readonly success: boolean;
  readonly returnData: string;
}

interface MulticallOptions {
  readonly address?: string;
  readonly logger?: (message: string) => void;
}

type HardhatRuntimeEnvironment = {
  readonly ethers: {
    getContractAt: (abi: any, address: string) => Promise<{
      readonly interface: Interface;
      readonly getFunction: (name: string) => any;
    }>;
  };
};

export async function executeMulticall(
  hre: HardhatRuntimeEnvironment,
  requests: MulticallRequest[],
  options?: MulticallOptions,
): Promise<MulticallResult[] | null> {
  if (requests.length === 0) {
    return [];
  }

  const address = options?.address ?? DEFAULT_MULTICALL3_ADDRESS;

  try {
    const contract = await hre.ethers.getContractAt(MULTICALL3_ABI, address);
    const formatted = requests.map((request) => ({
      target: request.target,
      allowFailure: request.allowFailure ?? true,
      callData: request.callData,
    }));
    const results = await contract.getFunction("aggregate3").staticCall(formatted);
    return results.map((result: { success: boolean; returnData: string }) => ({
      success: Boolean(result.success),
      returnData: result.returnData,
    }));
  } catch (error) {
    options?.logger?.(
      `Multicall unavailable at ${address}: ${error instanceof Error ? error.message : String(error)}. Falling back to individual calls.`,
    );
    return null;
  }
}
