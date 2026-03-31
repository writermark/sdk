// Vendored from crypto-vdf-js (Apache 2.0)
// https://github.com/jose-compu/crypto-vdf-js

export class InvalidProof extends Error {
  constructor() {
    super('Invalid proof')
    this.name = 'InvalidProof'
  }
}

export class InvalidIterations extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidIterations'
  }
}

export interface VDFParams<T extends VDF> {
  new(): T
}

export interface VDF {
  solve(challenge: Uint8Array, difficulty: number, discriminant?: bigint): Promise<Uint8Array>
  checkDifficulty(difficulty: number): void
  verify(challenge: Uint8Array, difficulty: number, allegedSolution: Uint8Array, discriminant?: bigint): void
}
