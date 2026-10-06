export interface FileEncodingOption {
  value: string;
  text: string;
}

/**
 * 文件编码选项列表 (与后端的 iconv-lite 解码支持匹配)
 */
export const FILE_ENCODING_OPTIONS: FileEncodingOption[] = [
  // Unicode
  { value: 'utf-8', text: 'UTF-8' },
  { value: 'utf-16le', text: 'UTF-16 LE' },
  { value: 'utf-16be', text: 'UTF-16 BE' },
  // Chinese
  { value: 'gbk', text: 'GBK' },
  { value: 'gb18030', text: 'GB18030' },
  { value: 'big5', text: 'Big5 (Traditional Chinese)' },
  // Japanese
  { value: 'shift_jis', text: 'Shift-JIS' },
  { value: 'euc-jp', text: 'EUC-JP' },
  // Korean
  { value: 'euc-kr', text: 'EUC-KR' },
  // Western European
  { value: 'iso-8859-1', text: 'ISO-8859-1 (Latin-1)' },
  { value: 'iso-8859-15', text: 'ISO-8859-15 (Latin-9)' },
  { value: 'cp1252', text: 'Windows-1252' },
  // Central European
  { value: 'iso-8859-2', text: 'ISO-8859-2 (Latin-2)' },
  { value: 'cp1250', text: 'Windows-1250' },
  // Cyrillic
  { value: 'iso-8859-5', text: 'ISO-8859-5 (Cyrillic)' },
  { value: 'cp1251', text: 'Windows-1251 (Cyrillic)' },
  { value: 'koi8-r', text: 'KOI8-R' },
  { value: 'koi8-u', text: 'KOI8-U' },
  // Greek
  { value: 'iso-8859-7', text: 'ISO-8859-7 (Greek)' },
  { value: 'cp1253', text: 'Windows-1253 (Greek)' },
  // Turkish
  { value: 'iso-8859-9', text: 'ISO-8859-9 (Turkish)' },
  { value: 'cp1254', text: 'Windows-1254 (Turkish)' },
  // Hebrew
  { value: 'iso-8859-8', text: 'ISO-8859-8 (Hebrew)' },
  { value: 'cp1255', text: 'Windows-1255 (Hebrew)' },
  // Arabic
  { value: 'iso-8859-6', text: 'ISO-8859-6 (Arabic)' },
  { value: 'cp1256', text: 'Windows-1256 (Arabic)' },
  // Baltic
  { value: 'iso-8859-4', text: 'ISO-8859-4 (Baltic)' },
  { value: 'iso-8859-13', text: 'ISO-8859-13 (Baltic)' },
  { value: 'cp1257', text: 'Windows-1257 (Baltic)' },
  // Vietnamese
  { value: 'cp1258', text: 'Windows-1258 (Vietnamese)' },
  // Thai
  { value: 'tis-620', text: 'TIS-620 (Thai)' },
  { value: 'cp874', text: 'Windows-874 (Thai)' },
];
