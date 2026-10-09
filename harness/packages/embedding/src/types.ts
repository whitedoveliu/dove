/** 从 core 复用的 EmbeddingProvider 形状（这里重新声明，避免 embedding 包反向依赖 core） */
export interface EmbeddingProvider {
  id: string;
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}
