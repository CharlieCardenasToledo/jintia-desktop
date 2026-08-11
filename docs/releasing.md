# Publicar Jintia Desktop

1. Actualiza `CHANGELOG.md` y las tres versiones de Desktop.
2. Ejecuta:

   ```bash
   npm ci
   npm test
   npm run build
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

3. CI valida el engine Jintia publicado y el contrato NotebookLM MCP
   administrado mediante sus smokes correspondientes.

4. Crea y publica un tag con la versión de Desktop:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

Los workflows publican EXE/MSI en Windows y DMG en macOS. La ejecución manual
solo conserva artifacts de Actions; GitHub Release requiere un tag.

Windows se publica sin firma mientras `SIGNPATH_ENABLED` no sea `true`. No
actives esa variable hasta completar la configuración descrita en
`CODE_SIGNING_POLICY.md`. El DMG tampoco debe anunciarse como firmado o
notarizado hasta que el pipeline lo verifique.
