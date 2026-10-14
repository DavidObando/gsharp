// <copyright file="MemberQuery.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Symbols

/// ADR-0112: describes which members the canonical member-resolution layer
/// ((cref:TypeMemberModel)) should surface — the static/instance/inherited
/// axes and a kind mask.
struct MemberQuery {
    /// Initializes a new instance of the (cref:MemberQuery) struct.
    /// @param includeInstance Whether instance members are surfaced.
    /// @param includeStatic Whether static (`shared`) members are surfaced.
    /// @param includeInherited Whether members from base classes are surfaced.
    /// @param kinds The member-kind mask.
    init(includeInstance bool, includeStatic bool, includeInherited bool, kinds MemberKinds) {
        this.IncludeInstance = includeInstance
        this.IncludeStatic = includeStatic
        this.IncludeInherited = includeInherited
        this.Kinds = kinds
    }

    /// Gets a value indicating whether instance members are surfaced.
    prop IncludeInstance bool {
        get;
    }

    /// Gets a value indicating whether static (`shared`) members are surfaced.
    prop IncludeStatic bool {
        get;
    }

    /// Gets a value indicating whether members from base classes are surfaced.
    prop IncludeInherited bool {
        get;
    }

    /// Gets the member-kind mask.
    prop Kinds MemberKinds {
        get;
    }

    /// Returns a copy of this query with the kind mask replaced.
    /// @param kinds The new kind mask.
    /// @returns The adjusted query.
    func WithKinds(kinds MemberKinds) MemberQuery -> MemberQuery(
        this.IncludeInstance,
        this.IncludeStatic,
        this.IncludeInherited,
        kinds
    )

    shared {
        /// Gets a query matching every member (instance + static + inherited, all
        /// kinds). This mirrors the historic language-server enumeration semantics
        /// (property → field → event → method, instance then static, walking the
        /// base chain) and is the parity-preserving default for hover/lookup.
        private let _all MemberQuery = MemberQuery(
            includeInstance: true,
            includeStatic: true,
            includeInherited: true,
            MemberKinds.All
        )

        prop All MemberQuery {
            get {
                return _all
            }
        }

        /// Gets a query matching instance members of the given kinds, walking the base chain.
        /// @param kinds The member-kind mask.
        /// @returns The configured query.
        func Instance(kinds MemberKinds = MemberKinds.All) MemberQuery -> MemberQuery(
            includeInstance: true,
            includeStatic: false,
            includeInherited: true,
            kinds
        )

        /// Gets a query matching static members of the given kinds (no base-chain walk, matching historic
        /// static-completion semantics).
        /// @param kinds The member-kind mask.
        /// @returns The configured query.
        func Static(kinds MemberKinds = MemberKinds.All) MemberQuery -> MemberQuery(
            includeInstance: false,
            includeStatic: true,
            includeInherited: false,
            kinds
        )

        /// Gets a query matching static members of the given kinds, walking the base-class chain.
        /// @param kinds The member-kind mask.
        /// @returns The configured query.
        func InheritedStatic(kinds MemberKinds = MemberKinds.All) MemberQuery -> MemberQuery(
            includeInstance: false,
            includeStatic: true,
            includeInherited: true,
            kinds
        )
    }
}
