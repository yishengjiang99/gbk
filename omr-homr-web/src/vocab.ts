/*
 * Vocabulary and constants for the homr transformer, exported from the Python
 * oracle (homr/transformer/vocabulary.py + configs.py). Part of omr-homr-web,
 * licensed under AGPL-3.0-only. See NOTICE for attribution.
 */
import vocabJson from "./homr-vocab.json" with { type: "json" };

interface VocabJson {
  rhythm_id_to_token: Record<string, string>;
  pitch_id_to_token: Record<string, string>;
  lift_id_to_token: Record<string, string>;
  articulation_id_to_token: Record<string, string>;
  slur_id_to_token: Record<string, string>;
  position_id_to_token: Record<string, string>;
  pad_token: number;
  bos_token: number;
  eos_token: number;
  nonote_token: number;
  max_seq_len: number;
  decoder_heads: number;
  decoder_dim: number;
  decoder_depth: number;
  encoder_mean: number;
  encoder_std: number;
}

const V = vocabJson as VocabJson;

function invertIds(map: Record<string, string>): string[] {
  const ids = Object.keys(map).map(Number).sort((a, b) => a - b);
  return ids.map((id) => map[String(id)]);
}

export const RHYTHM_TOKENS = invertIds(V.rhythm_id_to_token);
export const PITCH_TOKENS = invertIds(V.pitch_id_to_token);
export const LIFT_TOKENS = invertIds(V.lift_id_to_token);
export const ARTICULATION_TOKENS = invertIds(V.articulation_id_to_token);
export const SLUR_TOKENS = invertIds(V.slur_id_to_token);
export const POSITION_TOKENS = invertIds(V.position_id_to_token);

export const PAD_TOKEN = V.pad_token;
export const BOS_TOKEN = V.bos_token;
export const EOS_TOKEN = V.eos_token;
export const NONOTE_TOKEN = V.nonote_token;
export const MAX_SEQ_LEN = V.max_seq_len;
export const DECODER_HEADS = V.decoder_heads;
export const DECODER_DIM = V.decoder_dim;
export const DECODER_DEPTH = V.decoder_depth;
export const DECODER_KV_LAYERS = V.decoder_depth * 4; // 32: self K/V + cross K/V per layer
export const ENCODER_MEAN = V.encoder_mean;
export const ENCODER_STD = V.encoder_std;

/** One decoded symbol: the six head tokens plus the attention-derived position. */
export interface DecodedSymbol {
  rhythm: string;
  pitch: string;
  lift: string;
  articulation: string;
  slur: string;
  position: string;
  /** [x, y] from the decoder's attention output, in staff-crop pixels. Coarse. */
  attention: [number, number];
}
