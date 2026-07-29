/* CSVパーサ。
   以前は PapaParse を CDN から同期読み込みしていたが、
     - `<head>` の同期 <script> がHTMLのパースを止める
     - CDN が落ちる/塞がれると一覧が丸ごと出ない
     - 外部スクリプトなので Service Worker のオフライン対応から外れる
   の3点が同時に問題になっていた。data/ のCSVは RFC 4180 に沿った素直な形
   （引用符つき・引用符の中にカンマと改行を許す）なので、必要な範囲だけを
   自前で持つほうが依存も速度も素直になる。 */

/** RFC 4180 準拠の最小パーサ。戻り値は行の配列（各行はセルの配列）。 */
export function parseCsv(text){
  const rows = [];
  let row = [], cell = "", quoted = false;
  // BOM は先頭の列名を壊すので落とす
  const s = String(text || "").replace(/^﻿/, "");

  for(let i = 0; i < s.length; i++){
    const c = s[i];
    if(quoted){
      if(c === '"'){
        if(s[i+1] === '"'){ cell += '"'; i++; }   // "" はエスケープされた "
        else quoted = false;
      } else cell += c;
      continue;
    }
    if(c === '"'){ quoted = true; continue; }
    if(c === ","){ row.push(cell); cell = ""; continue; }
    if(c === "\r"){ continue; }                   // CRLF の CR は捨てる
    if(c === "\n"){ row.push(cell); rows.push(row); row = []; cell = ""; continue; }
    cell += c;
  }
  // 末尾に改行が無いファイルの最終行を取りこぼさない
  if(cell !== "" || row.length){ row.push(cell); rows.push(row); }

  // 完全な空行（区切りも値も無い行）は落とす
  return rows.filter(r => !(r.length === 1 && r[0].trim() === ""));
}

/** ヘッダー行を見て、1行 = 1オブジェクトに畳む。 */
export function parseCsvObjects(text){
  const rows = parseCsv(String(text || "").trim());
  if(!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  return rows.slice(1).map(cells => {
    const o = {};
    header.forEach((h, i) => { o[h] = cells[i] != null ? cells[i] : ""; });
    return o;
  });
}

/**
 * 列名 → 変換関数の対応表で行を写す。
 * 以前は parseEventsCSV / parseMoviesCSV / parseLivesCSV に同じ形の
 * マッピングを3回手書きしていた。列が増えるたびに3か所直す必要があり、
 * 1か所だけ忘れる事故が起きやすかったので、対応表をデータとして渡す形にした。
 *
 * columns: { 出力プロパティ名: [CSVの列名, 変換関数] }
 */
export function mapRows(text, columns, extra){
  const objects = parseCsvObjects(text);
  const entries = Object.entries(columns);
  return objects.map((row, i) => {
    const out = {};
    for(const [prop, [col, cast]] of entries) out[prop] = cast(row[col]);
    return extra ? extra(out, row, i) : out;
  });
}
