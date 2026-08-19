import { randomBytes } from 'node:crypto';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const CHS_MEDICAL_ID_SYSTEM = 'urn:chs:id:medical-id:v1';
export const CHS_MEDICAL_ID_TYPE = 'CHS_MEDICAL_ID';

export function generateChsMedicalId(): string {
  const bytes = randomBytes(12);
  const characters = Array.from(bytes, (byte) => alphabet[byte & 31]).join('');
  return `CHS-${characters.slice(0, 4)}-${characters.slice(4, 8)}-${characters.slice(8)}`;
}
