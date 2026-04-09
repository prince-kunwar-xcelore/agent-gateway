import { getArg } from '../args';
import { generateKeypair } from '../keys';

export function runGenerateKeys(args: string[]): void {
  const privateKeyPath = getArg(args, '--private-key', 'private.pem')!;
  const publicKeyPath  = getArg(args, '--public-key',  'public.pem')!;
  generateKeypair(privateKeyPath, publicKeyPath);
}
