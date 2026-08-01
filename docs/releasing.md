# Publicar Jintia Desktop

1. Actualiza `CHANGELOG.md` y las tres versiones de Desktop.
2. Si corresponde, sincroniza una release oficial de la skill:

   ```bash
   npm run skill:sync -- --tag=vX.Y.Z
   ```

3. Ejecuta:

   ```bash
   npm ci
   npm run skill:verify
   npm test
   npm run build
   cargo test --manifest-path src-tauri/Cargo.toml
   ```

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
