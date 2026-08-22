# Solución de problemas

Para problemas del **contenido de una guía** (reglas `JIN-*`, procedencia de
evidencia, bibliografía, `jintia ready`), consulta el
[`troubleshooting.md` de la skill](https://github.com/CharlieCardenasToledo/jintia/blob/master/docs/troubleshooting.md).
Esta página cubre problemas propios de **Jintia Desktop**: instalación,
runtimes administrados y actualización de la skill.

## La instalación de la skill falla o hace rollback

Desktop instala la skill en un directorio de staging, la valida (contrato,
`package.json`, `SKILL.md`, smoke test) y solo entonces la activa. Si algo
falla, el staging se descarta y tu instalación anterior queda intacta — no
hay corrupción posible. Revisa el mensaje de error exacto:

- `"Jintia X requiere Jintia Desktop Y o superior"`: tu Desktop está
  desactualizado para esa versión de la skill. Desktop ya intenta resolver
  automáticamente la versión más reciente compatible en vez de instalar
  siempre `@latest`; si de todos modos ves este error, actualiza Jintia
  Desktop.
- `"El contrato MCP no usa el paquete canónico"` / errores de SRI: el
  paquete instalado no coincide con el contrato esperado — vuelve a
  intentar la instalación; si persiste, reporta el error.
- Errores de `npm install`: revisa la conexión de red; Desktop usa su propio
  Node/npm administrado, no el del sistema.

## `jintia doctor` marca Vivliostyle ausente

Instala Vivliostyle CLI desde Configuración > Entorno (Desktop lo administra
automáticamente) o manualmente:

```bash
npm install --global @vivliostyle/cli
```

## NotebookLM no autentica

- Comprueba que el MCP administrado esté configurado desde Configuración > Entorno.
- `get_health` solo confirma si existe un respaldo de sesión legible, no que
  la sesión siga válida contra Google.
- Si una operación real confirma un fallo de login, usa la opción de
  reautenticación desde la app.

## Un hook o `jintia validate` bloquea el flujo

Lee el código `JIN-*` reportado y corrige el archivo señalado en el propio
curso. Desktop no oculta ni reinterpreta estos códigos — los muestra tal
como los devuelve la skill.

## Windows falla en CI antes de probar la skill

Comprueba primero si el paso que falló instala dependencias del sistema
(Chocolatey, `winget`) — esos errores pertenecen al entorno del runner. Un
fallo dentro de `cargo test` o `npm test` sí corresponde al código de
Desktop.
