// Copyright (C) GSharp Authors. All rights reserved.

package Cs2Gs.Pipeline

import System
import System.IO

/// Keeps mirror version calculations separate from the destination's parent repository.
internal shared class RepositoryGitMetadata {
    internal func Prepare(source string, destination string) {
        let prefix = ProcessRunner.Run("git", []string{"-C", source, "rev-parse", "--show-prefix"}, source)
        if prefix.ExitCode == 0 && prefix.Stdout.Trim().Length == 0 {
            let head = ProcessRunner.Run("git", []string{"-C", source, "rev-parse", "--verify", "HEAD"}, source)
            Run(
                []string{
                    "clone",
                    "--quiet",
                    "--no-checkout",
                    "--no-hardlinks",
                    "--dissociate",
                    "--",
                    source,
                    destination
                },
                source
            )
            Run([]string{"-C", destination, "remote", "remove", "origin"}, destination)
            for remote in Run([]string{"-C", source, "remote"}, source).Split(
                '\n',
                StringSplitOptions.RemoveEmptyEntries
            ) {
                let name = remote.Trim()
                for url in Run([]string{"-C", source, "config", "--get-all", "remote." + name + ".url"}, source).Split(
                    '\n',
                    StringSplitOptions.RemoveEmptyEntries
                ) {
                    Run(
                        []string{"-C", destination, "config", "--add", "remote." + name + ".url", url.TrimEnd('\r')},
                        destination
                    )
                }
            }
            if head.ExitCode == 0 {
                let clonedHead = Run([]string{"-C", destination, "rev-parse", "--verify", "HEAD"}, destination)
                if !string.Equals(head.Stdout.Trim(), clonedHead.Trim(), StringComparison.Ordinal) {
                    throw InvalidOperationException("The source Git commit changed while the mirror was created.")
                }
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
        let result = ProcessRunner.Run("git", arguments, workingDirectory, TimeSpan.FromMinutes(5))
        if result.ExitCode != 0 {
            throw InvalidOperationException("Cannot prepare mirror Git metadata: " + result.Output)
        }
        return result.Stdout
    }
}
