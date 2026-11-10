// Matrix durable-goal process-ownership helper (Linux only).
//
// This is the reviewed OS ownership primitive referenced by the DUR-001
// decision record and consumed by lib/goal-policy.mjs. It exists because Node
// has no pidfd binding; a dedicated, auditable, dependency-free helper is the
// selected mechanism. It never decides *policy*: callers pass the exact boot
// id and start time recorded at dispatch, and the helper verifies before it
// signals, using pidfds so a pinned file descriptor - not a bare pid - is the
// thing being signalled.
//
// Commands (all output is one bounded JSON object on stdout):
//
//   probe
//     Checks that pidfd_open/pidfd_send_signal work and /proc identity
//     sources are readable. Exit 0 with {"ok":true,...} or exit 2 otherwise.
//
//   verify --pid N --boot-id B --start-time T [--pgrp G]
//     Opens a pidfd for N, re-reads /proc/N/stat, and compares the host boot
//     id, the start time (field 22) and optionally the process group id.
//     Exit 0 "alive" when identity matches, 4 "absent" when the pid has no
//     task, 3 "identity-mismatch" when the task belongs to someone else, 2 on
//     usage/environment errors. Nothing is signalled.
//
//   kill --pid N --boot-id B --start-time T [--pgrp G] --sig S --wait-ms M
//     Re-verifies identity exactly like verify, refuses to signal on any
//     mismatch, then signals via pidfd_send_signal and polls the pidfd with
//     POLLIN until the pinned task exits or the wait budget expires.
//     Exit 0 when the task is gone (signalled or already dead/zombie),
//     3 on identity mismatch (nothing signalled), 4 when absent, 5 when
//     still alive at the deadline, 2 on usage/environment errors.
//
//   wait --pid N --boot-id B --start-time T --wait-ms M
//     verify + poll, without signalling. Exit codes mirror kill.
//
// A PID whose start time differs from the recorded value is a different
// task: the original task exited and its pid was reused. The current
// occupant is never signalled by this helper. A boot-id mismatch is fatal
// for verification (exit 3); callers decide how to report it.
//
// Build: node scripts/build-pidfd-helper.mjs
#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef __NR_pidfd_open
#define __NR_pidfd_open 434
#endif
#ifndef __NR_pidfd_send_signal
#define __NR_pidfd_send_signal 424
#endif

#define MAX_STAT_BYTES 8192
#define MAX_BOOT_ID 128
#define MAX_WAIT_MS 60000

static int pidfd_open_(pid_t pid, unsigned flags) {
  return (int)syscall(__NR_pidfd_open, pid, flags);
}

static int pidfd_send_signal_(int fd, int sig, siginfo_t *info, unsigned flags) {
  return (int)syscall(__NR_pidfd_send_signal, fd, sig, info, flags);
}

static void print_result(const char *result, const char *detail) {
  if (detail) {
    printf("{\"result\":\"%s\",\"detail\":\"%s\"}\n", result, detail);
  } else {
    printf("{\"result\":\"%s\"}\n", result);
  }
}

static void print_error(const char *detail) {
  printf("{\"result\":\"error\",\"detail\":\"%s\"}\n", detail);
}

/* Read /proc/<pid>/stat into buf. Returns 0 on success, -1 when absent. */
static int read_proc_stat(pid_t pid, char *buf, size_t buf_len) {
  char path[64];
  int written = snprintf(path, sizeof(path), "/proc/%d/stat", (int)pid);
  if (written < 0 || (size_t)written >= sizeof(path)) return -1;
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t total = 0;
  for (;;) {
    ssize_t count = read(fd, buf + total, buf_len - 1 - (size_t)total);
    if (count < 0) {
      if (errno == EINTR) continue;
      close(fd);
      return -1;
    }
    if (count == 0) break;
    total += count;
    if ((size_t)total >= buf_len - 1) {
      close(fd);
      return -1;
    }
  }
  close(fd);
  buf[total] = '\0';
  return 0;
}

/* Parse the fields after "pid (comm) ". Field numbers are the 1-based
 * overall /proc stat field numbers minus 3 (state is field 3). */
struct proc_identity {
  char state;
  long pgrp;
  unsigned long long starttime;
};

static int parse_proc_stat(const char *buf, struct proc_identity *out) {
  const char *rparen = strrchr(buf, ')');
  if (!rparen) return -1;
  const char *rest = rparen + 1;
  while (*rest == ' ') rest++;
  char state = rest[0];
  /* Tokenize the fields after state. values[0] is ppid (overall field 4),
   * so overall field N maps to values[N - 4]. */
  const char *field = rest + 1;
  unsigned long long values[32];
  int count = 0;
  while (*field && count < 32) {
    while (*field == ' ') field++;
    if (!*field) break;
    errno = 0;
    char *end = NULL;
    unsigned long long value = strtoull(field, &end, 10);
    if (end == field || errno == ERANGE) return -1;
    values[count++] = value;
    field = end;
  }
  if (count < 19) return -1;
  out->state = state;
  out->pgrp = (long)values[1];             /* overall field 5, pgrp */
  out->starttime = values[18];             /* overall field 22, starttime */
  return 0;
}

static int read_boot_id(char *out, size_t out_len) {
  int fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t total = read(fd, out, out_len - 1);
  close(fd);
  if (total <= 0) return -1;
  out[total] = '\0';
  size_t end = strlen(out);
  while (end > 0 && (out[end - 1] == '\n' || out[end - 1] == ' ')) out[--end] = '\0';
  return end > 0 ? 0 : -1;
}

static bool boot_id_matches(const char *expected) {
  char current[MAX_BOOT_ID + 2];
  if (read_boot_id(current, sizeof(current)) != 0) return false;
  return strcmp(current, expected) == 0;
}

static bool parse_long(const char *value, long *out) {
  if (!value || !*value) return false;
  errno = 0;
  char *end = NULL;
  long parsed = strtol(value, &end, 10);
  if (end == value || *end != '\0' || errno == ERANGE) return false;
  *out = parsed;
  return true;
}

static bool parse_u64(const char *value, unsigned long long *out) {
  if (!value || !*value) return false;
  errno = 0;
  char *end = NULL;
  unsigned long long parsed = strtoull(value, &end, 10);
  if (end == value || *end != '\0' || errno == ERANGE) return false;
  *out = parsed;
  return true;
}

/* locate --name value in argv; returns pointer to value or NULL */
static const char *arg_value(int argc, char **argv, const char *name) {
  for (int i = 2; i + 1 < argc; i += 1) {
    if (strcmp(argv[i], name) == 0) return argv[i + 1];
  }
  return NULL;
}

/*
 * Shared verification gate for verify/kill/wait. Returns:
 *   0 verified (or already zombie/dead, reported via out->state)
 *   3 identity mismatch
 *   4 absent
 *  -1 usage/environment error (exit 2)
 */
static int verify_task(pid_t pid, const char *boot_id, unsigned long long start_time,
                       bool check_pgrp, long pgrp, struct proc_identity *out, int *out_pidfd) {
  if (out_pidfd) *out_pidfd = -1;
  if (!boot_id || !boot_id[0]) {
    errno = EINVAL;
    return -1;
  }
  /* Host boot must match before trusting any pid. */
  if (!boot_id_matches(boot_id)) {
    errno = EOWNERDEAD; /* boot/namespace mismatch, deliberately not retryable */
    return 3;
  }
  int pidfd = pidfd_open_(pid, 0);
  if (pidfd < 0) {
    if (errno == ESRCH) return 4;
    return -1;
  }
  /* Pin first, then re-verify through /proc. A pidfd keeps the task struct
   * referenced, so the start time we read after pinning is the start time
   * of exactly the task the pidfd refers to. */
  char statbuf[MAX_STAT_BYTES];
  if (read_proc_stat(pid, statbuf, sizeof(statbuf)) != 0 ||
      parse_proc_stat(statbuf, out) != 0) {
    /* The task may have exited and been reaped between pin and read. */
    close(pidfd);
    return 4;
  }
  if (out->starttime != start_time) {
    close(pidfd);
    /* A different task occupies the pid; the original exited. */
    return 3;
  }
  if (check_pgrp && out->pgrp != pgrp) {
    close(pidfd);
    return 3;
  }
  if (out_pidfd) {
    *out_pidfd = pidfd;
  } else {
    close(pidfd);
  }
  return 0;
}

static int wait_pidfd(int pidfd, long wait_ms) {
  long elapsed = 0;
  while (elapsed <= wait_ms) {
    int slice = (int)(wait_ms - elapsed > 50 ? 50 : wait_ms - elapsed);
    if (slice <= 0) slice = 1;
    struct pollfd pfd = { pidfd, POLLIN, 0 };
    int ready = poll(&pfd, 1, slice);
    if (ready < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    if (ready > 0 && (pfd.revents & (POLLIN | POLLERR | POLLHUP))) return 1;
    elapsed += slice;
  }
  return 0;
}

static int command_probe(void) {
  int fd = open("/proc/self/stat", O_RDONLY | O_CLOEXEC);
  if (fd < 0) {
    printf("{\"ok\":false,\"error\":\"procfs is not readable\"}\n");
    return 2;
  }
  close(fd);
  char boot_id[MAX_BOOT_ID + 2];
  if (read_boot_id(boot_id, sizeof(boot_id)) != 0) {
    printf("{\"ok\":false,\"error\":\"boot id is not readable\"}\n");
    return 2;
  }
  int pidfd = pidfd_open_(getpid(), 0);
  if (pidfd < 0) {
    printf("{\"ok\":false,\"error\":\"pidfd_open is unavailable\",\"errno\":%d}\n", errno);
    return 2;
  }
  int check = pidfd_send_signal_(pidfd, 0, NULL, 0);
  close(pidfd);
  if (check != 0) {
    printf("{\"ok\":false,\"error\":\"pidfd_send_signal is unavailable\",\"errno\":%d}\n", errno);
    return 2;
  }
  printf("{\"ok\":true,\"pidfd\":true,\"procfs\":true,\"bootId\":\"%s\"}\n", boot_id);
  return 0;
}

static int command_verify(int argc, char **argv) {
  const char *pid_arg = arg_value(argc, argv, "--pid");
  const char *boot_id = arg_value(argc, argv, "--boot-id");
  const char *start_arg = arg_value(argc, argv, "--start-time");
  const char *pgrp_arg = arg_value(argc, argv, "--pgrp");
  long pid_l, pgrp = 0;
  unsigned long long start_time = 0;
  if (!parse_long(pid_arg, &pid_l) || pid_l <= 0 || !parse_u64(start_arg, &start_time) ||
      (pgrp_arg && !parse_long(pgrp_arg, &pgrp))) {
    print_error("invalid verify arguments");
    return 2;
  }
  pid_t pid = (pid_t)pid_l;
  struct proc_identity identity = { 0, 0, 0 };
  int result = verify_task(pid, boot_id, start_time, pgrp_arg != NULL, pgrp, &identity, NULL);
  if (result == -1) {
    print_error("environment does not support pidfd verification");
    return 2;
  }
  if (result == 3) {
    print_result("identity-mismatch", boot_id_matches(boot_id) ? "task identity mismatch" : "boot id mismatch");
    return 3;
  }
  if (result == 4) {
    print_result("absent", NULL);
    return 4;
  }
  printf("{\"result\":\"alive\",\"state\":\"%c\",\"pgrp\":%ld}\n", identity.state, identity.pgrp);
  return 0;
}

static int command_signal(int argc, char **argv, bool signal_it) {
  const char *pid_arg = arg_value(argc, argv, "--pid");
  const char *boot_id = arg_value(argc, argv, "--boot-id");
  const char *start_arg = arg_value(argc, argv, "--start-time");
  const char *pgrp_arg = arg_value(argc, argv, "--pgrp");
  const char *sig_arg = arg_value(argc, argv, "--sig");
  const char *wait_arg = arg_value(argc, argv, "--wait-ms");
  long pid_l, pgrp = 0, sig_l, wait_l;
  unsigned long long start_time = 0;
  if (!parse_long(pid_arg, &pid_l) || pid_l <= 0 || !parse_u64(start_arg, &start_time) ||
      !parse_long(wait_arg, &wait_l) || wait_l < 0 || wait_l > MAX_WAIT_MS ||
      (pgrp_arg && !parse_long(pgrp_arg, &pgrp)) ||
      (signal_it && (!parse_long(sig_arg, &sig_l) || sig_l <= 0 || sig_l > 64))) {
    print_error("invalid arguments");
    return 2;
  }
  pid_t pid = (pid_t)pid_l;
  struct proc_identity identity = { 0, 0, 0 };
  int pidfd = -1;
  int result = verify_task(pid, boot_id, start_time, pgrp_arg != NULL, pgrp, &identity, &pidfd);
  if (result == -1) {
    print_error("environment does not support pidfd verification");
    return 2;
  }
  if (result == 3) {
    print_result("identity-mismatch", boot_id_matches(boot_id) ? "task identity mismatch" : "boot id mismatch");
    return 3;
  }
  if (result == 4) {
    print_result("absent", NULL);
    return 4;
  }
  if (identity.state == 'Z') {
    /* A zombie is already stopped; it cannot run again. */
    close(pidfd);
    print_result("already-dead", "zombie");
    return 0;
  }
  if (signal_it) {
    if (pidfd_send_signal_(pidfd, (int)sig_l, NULL, 0) != 0) {
      int err = errno;
      close(pidfd);
      if (err == ESRCH) {
        print_result("absent", NULL);
        return 4;
      }
      print_error("pidfd_send_signal failed");
      return 2;
    }
  }
  int waited = wait_pidfd(pidfd, wait_l);
  close(pidfd);
  if (waited == 1) {
    print_result(signal_it ? "signalled" : "exited", NULL);
    return 0;
  }
  if (waited == 0) {
    print_result("still-alive", NULL);
    return 5;
  }
  print_error("poll failed");
  return 2;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: matrix-pidfd-helper <probe|verify|kill|wait> [options]\n");
    return 2;
  }
  if (strcmp(argv[1], "probe") == 0) return command_probe();
  if (strcmp(argv[1], "verify") == 0) return command_verify(argc, argv);
  if (strcmp(argv[1], "kill") == 0) return command_signal(argc, argv, true);
  if (strcmp(argv[1], "wait") == 0) return command_signal(argc, argv, false);
  fprintf(stderr, "unknown command: %s\n", argv[1]);
  return 2;
}
