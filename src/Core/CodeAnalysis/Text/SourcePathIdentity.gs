// <copyright file="SourcePathIdentity.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Text

import System
import System.IO

/// The one rule for "these two source paths name the same file". The language server keys a project's
/// files by the full path and compares ignoring case, so every place that pairs a tree with its
/// replacement (the project, the incremental reuse, cross-project navigation) must agree with it.
internal shared class SourcePathIdentity {
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
