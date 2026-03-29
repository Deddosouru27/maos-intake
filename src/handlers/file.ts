// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mammoth = require('mammoth');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const XLSX = require('xlsx');

export type FileSourceType = 'pdf' | 'docx' | 'xlsx';

export function detectFileSource(mimeType: string): FileSourceType | null {
  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return 'xlsx';
  return null;
}

export async function extractFileText(
  buffer: Buffer,
  sourceType: FileSourceType,
): Promise<string> {
  if (sourceType === 'pdf') {
    const data = await pdfParse(buffer) as { text: string };
    return data.text;
  }

  if (sourceType === 'docx') {
    const result = await mammoth.extractRawText({ buffer }) as { value: string };
    return result.value;
  }

  // xlsx — concatenate all sheets
  const wb = XLSX.read(buffer) as { SheetNames: string[]; Sheets: Record<string, unknown> };
  const lines: string[] = [];
  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    const csv = XLSX.utils.sheet_to_csv(sheet) as string;
    if (csv.trim()) lines.push(`[${sheetName}]\n${csv}`);
  }
  return lines.join('\n\n');
}
