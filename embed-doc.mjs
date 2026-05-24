/**
 * Script de embedding local via Ollama (nomic-embed-text)
 * Sin rate limits, sin internet, sin quota.
 * Corre con: node embed-doc.mjs
 * Soporta checkpoint: si se interrumpe, retoma desde donde quedó.
 */
import { createRequire } from 'module';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SERVER_MODULES = path.join(__dirname, 'server', 'node_modules');
const lancedb = require(path.join(SERVER_MODULES, '@lancedb', 'lancedb'));

// Config
const OLLAMA_BASE     = 'http://localhost:11434';
const EMBEDDING_MODEL = 'nomic-embed-text';
const WORKSPACE_SLUG  = 'cerebro';
const DOC_JSON        = path.join(__dirname, 'server/storage/documents/custom-documents/transcripciones_programa_aura.txt-69471748-81ee-4b40-a008-1dec2d720c01.json');
const LANCEDB_PATH    = path.join(__dirname, 'server/storage/lancedb');
const CHECKPOINT_FILE = path.join(__dirname, 'embed-checkpoint.json');
const CHUNK_SIZE      = 1500;
const CHUNK_OVERLAP   = 150;
const BATCH_SIZE      = 8; // Ollama es local, podemos usar batches más grandes

function chunkText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + CHUNK_SIZE, text.length);
    chunks.push(text.slice(start, end).trim());
    start += CHUNK_SIZE - CHUNK_OVERLAP;
  }
  return chunks.filter(c => c.length > 50);
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function embedBatch(texts) {
  const { default: fetch } = await import('node-fetch').catch(() => ({ default: globalThis.fetch }));
  const fetcher = fetch || globalThis.fetch;

  const response = await fetcher(`${OLLAMA_BASE}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: texts }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Ollama error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.embeddings; // array of float arrays
}

function loadCheckpoint() {
  if (existsSync(CHECKPOINT_FILE)) {
    try {
      const data = JSON.parse(readFileSync(CHECKPOINT_FILE, 'utf8'));
      console.log(`📂 Checkpoint encontrado: ${data.processed} chunks ya procesados`);
      return data;
    } catch {}
  }
  return { processed: 0, records: [] };
}

function saveCheckpoint(processed, records) {
  writeFileSync(CHECKPOINT_FILE, JSON.stringify({ processed, records }));
}

async function main() {
  // 1. Read doc
  console.log('📄 Leyendo documento...');
  const doc = JSON.parse(readFileSync(DOC_JSON, 'utf8'));
  const text = doc.pageContent || '';
  if (!text) { console.error('❌ pageContent vacío'); process.exit(1); }
  console.log(`   Chars: ${text.length.toLocaleString()}, Palabras: ${doc.wordCount?.toLocaleString()}`);

  // 2. Chunk
  console.log('✂️  Dividiendo en chunks...');
  const chunks = chunkText(text);
  console.log(`   Total chunks: ${chunks.length}`);

  // 3. Test Ollama
  console.log('🔌 Probando Ollama...');
  try {
    const test = await embedBatch(['test']);
    if (!test || !test[0]) throw new Error('Respuesta vacía');
    console.log(`   ✅ Ollama OK — dimensiones: ${test[0].length}`);
  } catch (e) {
    console.error(`   ❌ Error: ${e.message}`);
    console.error('   Asegúrate de que Ollama esté corriendo: ollama serve');
    process.exit(1);
  }

  // 4. Load checkpoint
  const checkpoint = loadCheckpoint();
  let records = checkpoint.records;
  let startFrom = checkpoint.processed;

  // 5. Embed all chunks
  console.log(`🔢 Embediendo chunks ${startFrom + 1}–${chunks.length} en batches de ${BATCH_SIZE}...`);

  for (let i = startFrom; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    try {
      const embeddings = await embedBatch(batch);
      batch.forEach((chunk, j) => {
        records.push({
          id:          `${doc.id}--${i + j}`,
          vector:      embeddings[j],
          text:        chunk,
          docId:       doc.id,
          title:       doc.title,
          chunkSource: `custom-documents/${path.basename(DOC_JSON)}`,
          wordCount:   chunk.split(' ').length,
        });
      });
      process.stdout.write(`\r   ✅ ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length} chunks`);
      saveCheckpoint(i + BATCH_SIZE, records);
    } catch (e) {
      console.error(`\n❌ Error en batch ${i}: ${e.message}`);
      process.exit(1);
    }
  }

  console.log(`\n   Total vectores: ${records.length}`);

  // 6. Save to LanceDB
  console.log('💾 Guardando en LanceDB...');
  const db = await lancedb.connect(LANCEDB_PATH);
  const tableName = `anythingllm_${WORKSPACE_SLUG}`;

  try {
    const existing = await db.openTable(tableName);
    await existing.delete(`id LIKE '${doc.id}%'`);
    await existing.add(records);
    console.log(`   Agregado a tabla existente "${tableName}"`);
  } catch (e) {
    await db.createTable(tableName, records);
    console.log(`   ✅ Tabla "${tableName}" creada`);
  }

  // 7. Register in SQLite
  console.log('📝 Registrando en base de datos...');
  const { execSync } = require('child_process');
  const docpath = `custom-documents/${path.basename(DOC_JSON)}`;
  const sqlCheck = `SELECT count(*) FROM workspace_documents WHERE docpath='${docpath}';`;
  const count = execSync(`sqlite3 "${path.join(__dirname, 'server/storage/anythingllm.db')}" "${sqlCheck}"`).toString().trim();

  if (count === '0') {
    const docId = path.basename(DOC_JSON).match(/([0-9a-f-]{36})\.json$/)?.[1] ?? doc.id;
    const sqlInsert = `INSERT INTO workspace_documents (docId, filename, docpath, workspaceId, pinned, watched, createdAt, lastUpdatedAt) VALUES ('${docId}', '${doc.title}', '${docpath}', 1, 0, 0, datetime('now'), datetime('now'));`;
    execSync(`sqlite3 "${path.join(__dirname, 'server/storage/anythingllm.db')}" "${sqlInsert}"`);
    console.log('   ✅ Documento registrado en workspace');
  } else {
    console.log('   ℹ️  Documento ya estaba registrado');
  }

  // Limpiar checkpoint
  if (existsSync(CHECKPOINT_FILE)) require('fs').unlinkSync(CHECKPOINT_FILE);

  console.log('\n🎉 ¡Listo! El documento está embedido y listo para consultas.');
  console.log('   Reinicia el servidor y luego haz preguntas sobre el programa Aura.');
}

main().catch(e => { console.error('\n❌ Error fatal:', e.message); process.exit(1); });
