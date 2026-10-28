// <copyright file="ServerCompilation.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.LanguageServer

import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax

/// Makes the compilations that the server builds for one document.
/// @remarks The server answers member-group queries (ADR-0212 slice S4), so its compilations record the
/// candidates of each call. `gsc` makes its compilations without this and pays nothing.
internal shared class ServerCompilation {
    /// Makes a compilation of [`tree`](paramref) that records member groups.
    /// @param tree The document's tree.
    /// @returns The compilation.
    func Create(tree SyntaxTree) Compilation {
        let created = Compilation(tree)
        created.RecordMemberGroups = true
        return created
    }
}
