// <copyright file="AccessPath.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Immutable
import System.Reflection
import System.Text

/// ADR-0069 addendum / issue #1180: the key the smart-cast flow analysis uses
/// to record a narrowing. It identifies the storage location whose runtime
/// type a successful test has proven, generalising the original
/// (cref:VariableSymbol) key to also cover a <em>stable member-access
/// path</em> — a chain of immutable members read through a stable receiver
/// (for example `x.shape` or `this.box.lid`).
/// @remarks An (cref:AccessPath) is the pair ((cref:Root),
/// (cref:Members)). The root is the variable the chain starts at
/// (a local, parameter, the receiver/`this` parameter, or a read-only
/// top-level `let`); the members are the immutable field / property
/// symbols or imported CLR members read in order, outermost last. A path with an empty
/// (cref:Members) list denotes a plain variable narrowing and is
/// equivalent to the historical (cref:VariableSymbol) key — hence the
/// implicit conversion from (cref:VariableSymbol) so the existing
/// variable-keyed call-sites continue to compile unchanged.
///
/// Equality is structural: two paths are equal when they share the same root
/// symbol and equal member identities. This lets analysis re-derive an equal
/// key every time it re-binds the same access expression.
class AccessPath : IEquatable[AccessPath] {
    private init(root VariableSymbol, members ImmutableArray[PathMember]) {
        Root = root
        Members = members
    }

    /// Gets the variable the access chain is rooted at.
    prop Root VariableSymbol {
        get;
    }

    /// Gets the immutable source symbols or imported CLR members read after
    /// the root, outermost last.
    /// Empty for a plain variable narrowing.
    prop Members ImmutableArray[PathMember] {
        get;
    }

    /// Gets a value indicating whether this path reads at least one member
    /// after its root (i.e. it is a member-access path rather than a plain
    /// variable).
    prop HasMembers bool -> !Members.IsDefaultOrEmpty

    /// Implicitly lifts a (cref:VariableSymbol) to its plain
    /// variable access path so historical variable-keyed code compiles
    /// against the generalised (cref:AccessPath)-keyed tables.
    /// @param variable The variable to lift.
    func operator implicit(variable VariableSymbol) AccessPath -> ForVariable(variable)

    /// Returns a new path that appends [`member`](paramref) to this one.
    /// @param member The immutable source member read after this path.
    /// @returns The extended path.
    func Append(member Symbol) AccessPath {
        let members = if Members.IsDefault {
            ImmutableArray[PathMember].Empty
        } else {
            Members
        }
        return AccessPath(Root, members.Add(PathMember(member)))
    }

    /// Returns a new path that appends [`member`](paramref) to this one.
    /// @param member The immutable imported CLR member read after this path.
    /// @returns The extended path.
    func Append(member MemberInfo) AccessPath {
        let members = if Members.IsDefault {
            ImmutableArray[PathMember].Empty
        } else {
            Members
        }
        return AccessPath(Root, members.Add(PathMember(member)))
    }

    /// Returns whether [`other`](paramref) is a prefix of this path (or
    /// equal to it). Used by invalidation: assigning to `x.f` drops every
    /// narrowing on a path that starts with `x.f` (e.g. `x.f.g`).
    /// @param other The candidate prefix.
    /// @returns `true` when this path starts with [`other`](paramref).
    func StartsWith(other AccessPath?) bool {
        if other == nil || !object.ReferenceEquals(Root, other.Root) {
            return false
        }
        let thisMembers = if Members.IsDefault {
            ImmutableArray[PathMember].Empty
        } else {
            Members
        }
        let otherMembers = if other.Members.IsDefault {
            ImmutableArray[PathMember].Empty
        } else {
            other.Members
        }
        if otherMembers.Length > thisMembers.Length {
            return false
        }
        for var i = 0; i < otherMembers.Length; i++ {
            if !thisMembers[i].Equals(otherMembers[i]) {
                return false
            }
        }
        return true
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    func Equals(other AccessPath?) bool {
        if other == nil || !object.ReferenceEquals(Root, other.Root) {
            return false
        }
        let a = if Members.IsDefault {
            ImmutableArray[PathMember].Empty
        } else {
            Members
        }
        let b = if other.Members.IsDefault {
            ImmutableArray[PathMember].Empty
        } else {
            other.Members
        }
        if a.Length != b.Length {
            return false
        }
        for var i = 0; i < a.Length; i++ {
            if !a[i].Equals(b[i]) {
                return false
            }
        }
        return true
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func Equals(obj object?) bool -> Equals(obj as AccessPath)

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func GetHashCode() int32 {
        var hash = default(HashCode)
        hash.Add(Root)
        if !Members.IsDefaultOrEmpty {
            for member in Members {
                hash.Add(member)
            }
        }
        return hash.ToHashCode()
    }

    /// ```xmldoc
    /// <inheritdoc />
    /// ```
    override func ToString() string {
        let builder = StringBuilder(Root?.Name ?? "<null>")
        if !Members.IsDefaultOrEmpty {
            for member in Members {
                builder.Append('.').Append(member.Name)
            }
        }
        return builder.ToString()
    }

    shared {
        /// Creates a plain variable access path.
        /// @param variable The root variable.
        /// @returns The access path.
        func ForVariable(variable VariableSymbol) AccessPath {
            ArgumentNullException.ThrowIfNull(variable, paramName: "variable")
            return AccessPath(variable, ImmutableArray[PathMember].Empty)
        }
    }
}
