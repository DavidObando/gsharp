// <copyright file="ServerPathIdentity.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import System
import System.IO

/// The language server's rule for "these two source paths name the same file". The server keys a
/// project's files by the full path and compares ignoring case. The rule is the one the compiler applies
/// when it pairs a tree with its replacement (`SourcePathIdentity` in `GSharp.Core`, which is not
/// visible to the server): two paths are the same when they are equal ignoring case, or when their
/// `Path.GetFullPath` forms are. An empty path names no file.
internal shared class ServerPathIdentity {
    /// Returns the full form of [`path`](paramref): no `.` or `..` segments, rooted.
    func Normalize(path string) string -> Path.GetFullPath(path)

    /// Returns whether [`left`](paramref) and [`right`](paramref) name the same file. An empty path names
    /// no file. A path that cannot be made absolute is compared as written, ignoring case.
    func AreSame(left string?, right string?) bool {
        if left == nil || right == nil || left.Length == 0 || right.Length == 0 {
            return false
        }
        if string.Equals(left, right, StringComparison.OrdinalIgnoreCase) {
            return true
        }
        try {
            return string.Equals(Normalize(left), Normalize(right), StringComparison.OrdinalIgnoreCase)
        } catch (ArgumentException) {
            return false
        } catch (NotSupportedException) {
            return false
        } catch (PathTooLongException) {
            return false
        }
    }
}
