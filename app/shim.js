/* Cockpit Plus – Abo-Verfahren: Verbindungsstück zwischen App und Server.
   Wird beim Ausliefern als erstes Skript in die App eingesetzt.
   - trennt die Daten pro Fahrzeug (eigener Bereich im Speicher)
   - meldet jede Änderung an die Kontoseite, die sie auf dem Server sichert
   - ohne angemeldete Kontoseite startet die App nicht                      */
(function () {
  var CP = null;
  try { CP = window.parent && window.parent !== window ? window.parent.CP : null; } catch (e) { CP = null; }
  if (!CP || !CP.vehicleId) {
    document.documentElement.innerHTML = '<body style="background:#000;color:#fff;font-family:Arial;padding:40px">' +
      'Cockpit Plus ist nur über die Anmeldung erreichbar.</body>';
    throw new Error('Cockpit Plus: keine Anmeldung');
  }

  var P = 'cp:' + CP.vehicleId + ':';
  var LS = window.localStorage;
  var S = Storage.prototype;
  var o = { get: S.getItem, set: S.setItem, rem: S.removeItem, key: S.key, clear: S.clear,
            len: Object.getOwnPropertyDescriptor(S, 'length').get };
  var own = function (k) { return typeof k === 'string' && !/^(sb-|cp_)/.test(k); };
  var myKeys = function () {
    var out = [], n = o.len.call(LS);
    for (var i = 0; i < n; i++) { var k = o.key.call(LS, i); if (k && k.indexOf(P) === 0) out.push(k.slice(P.length)); }
    return out;
  };

  S.getItem = function (k) { return this === LS && own(k) ? o.get.call(LS, P + k) : o.get.call(this, k); };
  S.setItem = function (k, v) {
    if (this !== LS || !own(k)) return o.set.call(this, k, v);
    v = String(v); o.set.call(LS, P + k, v); CP.kvSet(k, v);
  };
  S.removeItem = function (k) {
    if (this !== LS || !own(k)) return o.rem.call(this, k);
    o.rem.call(LS, P + k); CP.kvDel(k);
  };
  S.key = function (i) { return this === LS ? (myKeys()[i] || null) : o.key.call(this, i); };
  S.clear = function () {
    if (this !== LS) return o.clear.call(this);
    myKeys().forEach(function (k) { o.rem.call(LS, P + k); CP.kvDel(k); });
  };
  Object.defineProperty(S, 'length', { configurable: true, get: function () {
    return this === LS ? myKeys().length : o.len.call(this);
  } });

  // Dateien (Belegfotos, PDFs) – eigene Datenbank pro Fahrzeug + Sicherung auf dem Server
  var idbOpen = IDBFactory.prototype.open;
  IDBFactory.prototype.open = function (name, ver) {
    return idbOpen.call(this, P + name, ver);
  };
  var put = IDBObjectStore.prototype.put, del = IDBObjectStore.prototype.delete;
  IDBObjectStore.prototype.put = function (val, key) {
    var r = put.apply(this, arguments);
    try { if (key != null) CP.fileSet(this.transaction.db.name.slice(P.length), this.name, String(key), val); } catch (e) {}
    return r;
  };
  IDBObjectStore.prototype.delete = function (key) {
    var r = del.apply(this, arguments);
    try { CP.fileDel(this.transaction.db.name.slice(P.length), this.name, String(key)); } catch (e) {}
    return r;
  };

  // "Neu laden" der App (z. B. beim Jahreswechsel) startet sie im selben Fahrzeug neu
  window.addEventListener('beforeunload', function () { try { CP.flush(); } catch (e) {} });
})();
