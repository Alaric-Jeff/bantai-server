export function normalizePhoneNumber(phone: string): string {
  if (!phone) return phone;

  const cleaned = phone.replace(/\D/g, ''); // Strip all non-digit characters

  if (cleaned.startsWith('639') && cleaned.length === 12) {
    return `09${cleaned.slice(3)}`;
  }
  if (cleaned.startsWith('9') && cleaned.length === 10) {
    return `09${cleaned.slice(1)}`;
  }

  return cleaned;
}
