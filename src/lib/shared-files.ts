// Files shared to the installed app from another one: the service worker parks
// them in IndexedDB (see public/sw.js) and the Upload page takes them from here.

const DB = "dubplate-share"

/** Take (and forget) whatever was shared. Empty when nothing was, or IndexedDB isn't available. */
export function takeSharedFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    let open: IDBOpenDBRequest
    try {
      open = indexedDB.open(DB, 1)
    } catch {
      return resolve([])
    }
    open.onupgradeneeded = () => open.result.createObjectStore("files", { autoIncrement: true })
    open.onerror = () => resolve([])
    open.onsuccess = () => {
      const tx = open.result.transaction("files", "readwrite")
      const store = tx.objectStore("files")
      const all = store.getAll()
      all.onsuccess = () => {
        store.clear()
        const files = (all.result as Blob[]).map((b, i) => (b instanceof File ? b : new File([b], `shared-${i + 1}`, { type: b.type })))
        tx.oncomplete = () => resolve(files)
      }
      tx.onerror = () => resolve([])
    }
  })
}
