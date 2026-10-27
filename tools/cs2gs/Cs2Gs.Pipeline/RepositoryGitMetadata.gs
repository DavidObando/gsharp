// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Pipeline

import System
import System.IO
import System.Linq

/// Keeps mirror version calculations separate from the destination's parent repository.
internal shared class RepositoryGitMetadata {
    private let RepositoryEnvironmentVariables[]string = ReadRepositoryEnvironmentVariables()

    internal func Prepare(source string, destination string) {
        let prefix = Git([]string{"-C", source, "rev-parse", "--show-prefix"}, source)
        if prefix.ExitCode == 0 && prefix.Stdout.Trim().Length == 0 {
            let head = Git([]string{"-C", source, "rev-parse", "--verify", "HEAD"}, source)
            Directory.CreateDirectory(destination)
            Run(
                []string{
                    "clone",
                    "--quiet",
                    "--origin=origin",
                    "--mirror",
                    "--no-hardlinks",
                    "--dissociate",
                    "--",
                    source,
                    Path.Combine(destination, ".git")
                },
                source
            )
            Run([]string{"-C", destination, "config", "core.bare", "false"}, destination)
            Run([]string{"-C", destination, "config", "--remove-section", "remote.origin"}, destination)
            for remote in Run([]string{"-C", source, "remote"}, source).Split(
                '\n',
                StringSplitOptions.RemoveEmptyEntries
            ) {
                let name = remote.TrimEnd('\r')
                for suffix in[]string{"url", "pushurl"} {
                    let key = "remote." + name + "." + suffix
                    let configured = Git([]string{"-C", source, "config", "--null", "--get-all", key}, source)
                    if configured.TimedOut || (configured.ExitCode != 0 && configured.ExitCode != 1) {
                        throw InvalidOperationException("Cannot read source remote URLs: " + configured.Output)
                    }
                    if configured.ExitCode == 1 {
                        continue
                    }
                    for url in configured.Stdout.Split('\0').SkipLast(1) {
                        Run([]string{"-C", destination, "config", "--add", key, url}, destination)
                    }
                }
            }
            if head.ExitCode == 0 {
                let clonedHead = Run([]string{"-C", destination, "rev-parse", "--verify", "HEAD"}, destination)
                if !string.Equals(head.Stdout.Trim(), clonedHead.Trim(), StringComparison.Ordinal) {
                    throw InvalidOperationException("The source Git commit changed while the mirror was created.")
                }
                Run([]string{"-C", destination, "read-tree", "HEAD"}, destination)
            }
            return
        }
        if prefix.ExitCode == 0 {
            throw InvalidOperationException(
                "Repository migration requires the Git working-tree root. " +
                    "A source subdirectory cannot preserve repository-relative version history."
            )
        }
        if prefix.TimedOut || Directory.Exists(Path.Combine(source, ".git")) || File.Exists(
            Path.Combine(source, ".git")
        ) {
            throw InvalidOperationException("Cannot read source Git metadata: " + prefix.Output)
        }
        // An archive has no source history. Do not use the destination's parent history.
        Directory.CreateDirectory(destination)
        Run([]string{"init", "--quiet", "--", destination}, destination)
    }

    private func Run(arguments[]string, workingDirectory string) string {
        let result = Git(arguments, workingDirectory)
        if result.ExitCode != 0 {
            throw InvalidOperationException("Cannot prepare mirror Git metadata: " + result.Output)
        }
        return result.Stdout
    }

    private func Git(arguments[]string, workingDirectory string) ProcessRunResult -> ProcessRunner
        .RunWithRemovedEnvironment(
        "git",
        arguments,
        RepositoryEnvironmentVariables,
        workingDirectory,
        TimeSpan.FromMinutes(5)
    )

    private func ReadRepositoryEnvironmentVariables()[]string {
        let result = ProcessRunner.Run("git", []string{"rev-parse", "--local-env-vars"})
        if result.TimedOut || result.ExitCode != 0 {
            throw InvalidOperationException("Cannot read repository-local Git environment names: " + result.Output)
        }
        return result
            .Stdout
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select((name string) -> name.TrimEnd('\r'))
            .Concat([]string{"GIT_NAMESPACE", "GIT_QUARANTINE_PATH"})
            .ToArray()
    }
}
