//! Windows Job Object: agrupa todos los procesos administrados por Jintia
//! (OpenCode, Claude Code, Codex, NotebookLM MCP) bajo un único objeto con
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Cuando el handle del job se cierra
//! — al terminar el proceso de Jintia, incluso ante un crash — Windows mata
//! TODO el árbol asociado. Esto es más robusto que perseguir PIDs uno a uno
//! (`kill_child_tree`): también alcanza a descendientes que un proceso hijo
//! haya lanzado por su cuenta (p. ej. un Chromium que NotebookLM abra).

use std::os::windows::io::AsRawHandle;
use std::process::Child;
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub struct JobHandle(HANDLE);

// El handle de un Job Object no es un puntero a memoria compartida mutable
// sin sincronización propia: todas las llamadas Win32 sobre él son
// thread-safe por diseño de la API.
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

impl JobHandle {
    pub fn create() -> Result<Self, String> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return Err("No se pudo crear el Job Object de Windows.".to_string());
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;

            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(handle);
                return Err("No se pudo configurar KILL_ON_JOB_CLOSE en el Job Object.".to_string());
            }

            Ok(JobHandle(handle))
        }
    }

    /// Asigna un proceso ya lanzado al Job Object. Debe llamarse cuanto antes
    /// tras `spawn()` — una vez asignado, sus descendientes futuros heredan
    /// la membresía automáticamente.
    pub fn assign(&self, child: &Child) -> Result<(), String> {
        unsafe {
            let process_handle = child.as_raw_handle() as HANDLE;
            let ok = AssignProcessToJobObject(self.0, process_handle);
            if ok == 0 {
                return Err("No se pudo asignar el proceso al Job Object de Jintia.".to_string());
            }
        }
        Ok(())
    }
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
