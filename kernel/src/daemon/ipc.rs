//! Platform pieces of the daemon: its socket type, the same-user peer check, and the process
//! groups it signals. Unix uses process groups; Windows uses AF_UNIX sockets (Windows 10 1803+)
//! and Job Objects.
use std::io;

#[cfg(unix)]
pub use std::os::unix::net::{UnixListener as Listener, UnixStream as Stream};
#[cfg(windows)]
pub use uds_windows::{UnixListener as Listener, UnixStream as Stream};

/// Whether the connected peer runs as this daemon's user (never serve another user, even if the
/// socket were reachable).
#[cfg(any(target_os = "macos", target_os = "freebsd", target_os = "openbsd", target_os = "netbsd"))]
pub fn peer_is_self(s: &Stream) -> bool {
    use std::os::fd::AsRawFd;
    let (mut uid, mut gid) = (0 as libc::uid_t, 0 as libc::gid_t);
    (unsafe { libc::getpeereid(s.as_raw_fd(), &mut uid, &mut gid) } == 0) && uid == unsafe { libc::getuid() }
}

#[cfg(target_os = "linux")]
pub fn peer_is_self(s: &Stream) -> bool {
    use std::os::fd::AsRawFd;
    let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    let r = unsafe { libc::getsockopt(s.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED, &mut cred as *mut _ as *mut libc::c_void, &mut len) };
    r == 0 && cred.uid == unsafe { libc::getuid() }
}

/// The peer's process id (`SIO_AF_UNIX_GETPEERPID`), then its token's user SID compared with ours.
#[cfg(windows)]
pub fn peer_is_self(s: &Stream) -> bool {
    use std::os::windows::io::AsRawSocket;
    use windows_sys::Win32::Networking::WinSock::WSAIoctl;
    const SIO_AF_UNIX_GETPEERPID: u32 = 0x5800_0100; // _WSAIOR(IOC_VENDOR, 256)
    let (mut pid, mut got) = (0u32, 0u32);
    let r = unsafe {
        WSAIoctl(s.as_raw_socket() as usize, SIO_AF_UNIX_GETPEERPID, std::ptr::null(), 0,
            &mut pid as *mut u32 as *mut core::ffi::c_void, 4, &mut got, std::ptr::null_mut(), None)
    };
    // Windows fills `pid` but reports 0 bytes returned, so only the result and the pid count.
    let _ = got;
    if r != 0 || pid == 0 {
        let err = unsafe { windows_sys::Win32::Networking::WinSock::WSAGetLastError() };
        log::warn!("cannot identify the daemon socket peer (WSA error {err})");
        return false;
    }
    win::same_user(pid)
}

#[cfg(windows)]
mod win {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::Security::{EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER};
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};

    /// `TOKEN_USER` of a process, in a buffer aligned for it (the SID points into the buffer).
    fn token_user(process: HANDLE) -> Option<Vec<u64>> {
        unsafe {
            let mut token: HANDLE = std::ptr::null_mut();
            if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
                return None;
            }
            let mut len = 0u32;
            GetTokenInformation(token, TokenUser, std::ptr::null_mut(), 0, &mut len);
            let mut buf = vec![0u64; (len as usize).div_ceil(8).max(1)];
            let ok = GetTokenInformation(token, TokenUser, buf.as_mut_ptr() as *mut _, (buf.len() * 8) as u32, &mut len);
            CloseHandle(token);
            (ok != 0).then_some(buf)
        }
    }

    pub fn same_user(pid: u32) -> bool {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let theirs = token_user(process);
            CloseHandle(process);
            let (Some(theirs), Some(mine)) = (theirs, token_user(GetCurrentProcess())) else { return false };
            let sid = |b: &Vec<u64>| (*(b.as_ptr() as *const TOKEN_USER)).User.Sid;
            EqualSid(sid(&theirs), sid(&mine)) != 0
        }
    }
}

/// The processes one daemon resource started: a Unix process group, or a Windows Job Object
/// (closing the last handle ends whatever is left in it).
#[cfg(unix)]
#[derive(Clone)]
pub struct Group(i32);

#[cfg(unix)]
impl Group {
    /// The group of a child started as its own group or session leader.
    pub fn of_leader(pid: u32) -> io::Result<Group> { Ok(Group(pid as i32)) }

    /// `TERM`, `KILL`, `INT`, `HUP` or `QUIT` (anything else is `TERM`) to the whole group.
    pub fn signal(&self, name: &str) {
        let sig = match name { "KILL" => libc::SIGKILL, "INT" => libc::SIGINT, "HUP" => libc::SIGHUP, "QUIT" => libc::SIGQUIT, _ => libc::SIGTERM };
        unsafe { libc::kill(-self.0, sig) };
    }
}

#[cfg(windows)]
struct Job(windows_sys::Win32::Foundation::HANDLE);
#[cfg(windows)]
unsafe impl Send for Job {}
#[cfg(windows)]
unsafe impl Sync for Job {}
#[cfg(windows)]
impl Drop for Job {
    fn drop(&mut self) { unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0) }; }
}

#[cfg(windows)]
#[derive(Clone)]
pub struct Group(std::sync::Arc<Job>);

#[cfg(windows)]
impl Group {
    /// A new job holding `pid` (and, from then on, everything it starts).
    pub fn of_leader(pid: u32) -> io::Result<Group> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::*;
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return Err(io::Error::last_os_error());
            }
            let job = Job(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(job.0, JobObjectExtendedLimitInformation, &limits as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32);
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return Err(io::Error::last_os_error());
            }
            let ok = AssignProcessToJobObject(job.0, process);
            let err = io::Error::last_os_error();
            CloseHandle(process);
            if ok == 0 {
                return Err(err);
            }
            Ok(Group(std::sync::Arc::new(job)))
        }
    }

    /// Windows has no signals for console-less programs: every name ends the whole job.
    pub fn signal(&self, _name: &str) {
        unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject((self.0).0, 1) };
    }
}
