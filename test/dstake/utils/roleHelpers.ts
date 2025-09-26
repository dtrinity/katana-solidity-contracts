import { ethers } from "hardhat";
import type { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

export async function resolveRoleSigner(
  contract: { hasRole(role: string, account: string): Promise<boolean> },
  role: string,
  candidateAddresses: Array<string | undefined>,
  funder: SignerWithAddress,
): Promise<SignerWithAddress> {
  for (const candidate of candidateAddresses) {
    if (!candidate) continue;
    if (!(await contract.hasRole(role, candidate))) continue;
    if (candidate.toLowerCase() === funder.address.toLowerCase()) {
      return funder;
    }

    try {
      return await ethers.getSigner(candidate);
    } catch {
      const impersonated = await ethers.getImpersonatedSigner(candidate);
      const currentBalance = await ethers.provider.getBalance(candidate);
      if (currentBalance === 0n) {
        await funder.sendTransaction({ to: candidate, value: ethers.parseEther("1") });
      }
      return impersonated;
    }
  }

  throw new Error(`Unable to locate signer with role ${role}`);
}

export async function ensureRoleGranted(
  contract: {
    hasRole(role: string, account: string): Promise<boolean>;
    grantRole(role: string, account: string): Promise<void>;
  },
  role: string,
  grantee: SignerWithAddress,
  adminSigner: SignerWithAddress,
): Promise<void> {
  if (await contract.hasRole(role, grantee.address)) {
    return;
  }

  await contract.connect(adminSigner).grantRole(role, grantee.address);
}
