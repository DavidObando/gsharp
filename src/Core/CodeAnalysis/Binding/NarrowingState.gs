// <copyright file="NarrowingState.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis.Symbols
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection

/// The narrowing facts that hold at one program point (ADR-0208 sections 6
/// and 7).
/// @remarks The state is a value. Each operation returns a new state, so a
/// branch can keep the state it started from. Entries keep insertion order,
/// and no result depends on hash order. Equality is structural and ignores
/// entry order. A state holds two kinds of fact: a narrowed type for each
/// access path, and the set of variables that definitely hold an external
/// callable. Both kinds join the same way. Nothing in the binder consumes
/// this type yet (ADR-0208 section 19, PR 1).
internal sealed class NarrowingState : IEquatable[NarrowingState] {
    private let paths ImmutableArray[AccessPath]
    private let types ImmutableArray[TypeSymbol]
    private let callables ImmutableArray[VariableSymbol]
    private let unreachable bool

    private init(
        paths ImmutableArray[AccessPath],
        types ImmutableArray[TypeSymbol],
        callables ImmutableArray[VariableSymbol],
        unreachable bool
    ) {
        this.paths = paths
        this.types = types
        this.callables = callables
        this.unreachable = unreachable
    }

    prop IsUnreachable bool -> unreachable

    /// Gets the number of path facts.
    prop Count int32 -> paths.Length

    /// Gets the paths that have a fact, in insertion order.
    prop Paths ImmutableArray[AccessPath] -> paths

    /// Gets the variables that definitely hold an external callable, in
    /// insertion order.
    prop ExternalCallables ImmutableArray[VariableSymbol] -> callables

    /// The query. Returns the narrowed type of a stable path, or `nil`.
    /// An unreachable state has no facts.
    func NarrowedType(path AccessPath) TypeSymbol? {
        let index = IndexOf(path)
        return if index < 0 {
            default(TypeSymbol?)
        } else {
            types[index]
        }
    }

    func IsExternalCallable(variable VariableSymbol) bool {
        return !unreachable && callables.Contains(variable)
    }

    /// Adds or replaces the fact for [`path`](paramref).
    func With(path AccessPath, narrowedType TypeSymbol) NarrowingState {
        if unreachable {
            return this
        }
        let index = IndexOf(path)
        if index < 0 {
            return NarrowingState(paths.Add(path), types.Add(narrowedType), callables, false)
        }
        if object.Equals(types[index], narrowedType) {
            return this
        }
        return NarrowingState(paths, types.SetItem(index, narrowedType), callables, false)
    }

    func WithAll(facts IReadOnlyDictionary[AccessPath, TypeSymbol]) NarrowingState {
        var result = this
        for fact in facts {
            result = result.With(fact.Key, fact.Value)
        }
        return result
    }

    func WithExternalCallable(variable VariableSymbol) NarrowingState {
        if unreachable || callables.Contains(variable) {
            return this
        }
        return NarrowingState(paths, types, callables.Add(variable), false)
    }

    /// Removes the fact of one path.
    func Remove(path AccessPath) NarrowingState -> Without(
        (candidate AccessPath) -> candidate.Equals(path),
        (variable VariableSymbol) -> false
    )

    /// Removes every fact whose path root is in [`roots`](paramref), and the
    /// external-callable fact of each such root.
    func KillRoots(roots IReadOnlyCollection[VariableSymbol]) NarrowingState {
        return Without(
            (path AccessPath) -> roots.Contains(path.Root),
            (variable VariableSymbol) -> roots.Contains(variable)
        )
    }

    /// Removes the facts that the effects of a bound node end (ADR-0208
    /// section 8). A root the node assigns loses every path. A member write
    /// or a call removes every member-bearing path. A call that can write a
    /// mutable global removes the facts on globals. A write through a
    /// pointer removes the facts on every mutable root.
    /// @param effects The effects of the node.
    /// @param mayBeIndirectlyWritten Tells whether a call can write a root
    /// without naming it (a local that a closure assigns, or an alias
    /// class member). The caller owns this set. `nil` means no root.
    func Kill(effects StatementEffects, mayBeIndirectlyWritten((VariableSymbol) -> bool)? = nil) NarrowingState {
        if unreachable {
            return this
        }
        return Without(
            (path AccessPath) -> effects.AssignsRoot(path.Root) ||
                (path.HasMembers && effects.MayMutateMemberPaths) ||
                (effects.MayMutateGlobalRoots && path.Root is GlobalVariableSymbol) ||
                (effects.MayMutateWritableReferenceRoots && IsByReferenceParameter(path.Root)) ||
                (effects.MayMutateAnyRootViaPointer && (path.HasMembers || !path.Root.IsReadOnly)) ||
                (effects.MayMutateAnyRoot && mayBeIndirectlyWritten != nil && mayBeIndirectlyWritten(path.Root)),
            (variable VariableSymbol) -> effects.AssignsRoot(variable) ||
                (effects.MayMutateGlobalRoots && variable is GlobalVariableSymbol) ||
                (effects.MayMutateWritableReferenceRoots && IsByReferenceParameter(variable)) ||
                effects.MayMutateAnyRootViaPointer ||
                (effects.MayMutateAnyRoot && mayBeIndirectlyWritten != nil && mayBeIndirectlyWritten(variable))
        )
    }

    /// The genuine two-way merge: `Join([this, other])`.
    func Join(other NarrowingState) NarrowingState {
        return Join(List[NarrowingState]{this, other})
    }

    /// The state a closure body starts from (ADR-0069 issue #2442, ADR-0208
    /// P8): only plain-variable facts on read-only roots survive, and no
    /// external-callable fact does.
    func ForClosureBody() NarrowingState {
        if unreachable {
            return this
        }
        return Without((path AccessPath) -> path.HasMembers || !path.Root.IsReadOnly, (variable VariableSymbol) -> true)
    }

    func Equals(other NarrowingState?) bool {
        if other == nil {
            return false
        }
        if object.ReferenceEquals(this, other) {
            return true
        }
        if unreachable != other.unreachable ||
            paths.Length != other
            .paths
            .Length ||
            callables.Length != other
            .callables
            .Length {
            return false
        }
        for var i = 0; i < paths.Length; i++ {
            let index = other.IndexOf(paths[i])
            if index < 0 || !object.Equals(types[i], other.types[index]) {
                return false
            }
        }
        for callable in callables {
            if !other.callables.Contains(callable) {
                return false
            }
        }
        return true
    }

    override func Equals(obj object?) bool -> Equals(obj as NarrowingState)

    override func GetHashCode() int32 {
        // Order-insensitive so that it agrees with Equals.
        var hash = if unreachable {
            1
        } else {
            0
        }
        for var i = 0; i < paths.Length; i++ {
            hash += HashCode.Combine(paths[i], types[i])
        }
        return hash
    }

    override func ToString() string {
        if unreachable {
            return "<unreachable>"
        }
        let parts = List[string]()
        for var i = 0; i < paths.Length; i++ {
            parts.Add("${paths[i]} -> ${types[i]}")
        }
        for callable in callables {
            parts.Add("callable ${callable.Name}")
        }
        return "{" + string.Join(", ", parts) + "}"
    }

    // A callback can overwrite the caller-owned storage behind a ref or out parameter.
    private func IsByReferenceParameter(root VariableSymbol) bool -> root is ParameterSymbol &&
        (root.RefKind == RefKind.Ref || root.RefKind == RefKind.Out)

    private func IndexOf(path AccessPath) int32 {
        if unreachable {
            return -1
        }
        for var i = 0; i < paths.Length; i++ {
            if paths[i].Equals(path) {
                return i
            }
        }
        return -1
    }

    private func Without(dropPath(AccessPath) -> bool, dropCallable(VariableSymbol) -> bool) NarrowingState {
        var keptPaths ImmutableArray[AccessPath].Builder? = nil
        var keptTypes ImmutableArray[TypeSymbol].Builder? = nil
        for var i = 0; i < paths.Length; i++ {
            if dropPath(paths[i]) {
                if keptPaths == nil {
                    keptPaths = ImmutableArray.CreateBuilder[AccessPath]()
                    keptTypes = ImmutableArray.CreateBuilder[TypeSymbol]()
                    for var j = 0; j < i; j++ {
                        keptPaths.Add(paths[j])
                        keptTypes.Add(types[j])
                    }
                }
            } else if keptPaths != nil {
                keptPaths.Add(paths[i])
                keptTypes!!.Add(types[i])
            }
        }
        var keptCallables ImmutableArray[VariableSymbol].Builder? = nil
        for var i = 0; i < callables.Length; i++ {
            if dropCallable(callables[i]) {
                if keptCallables == nil {
                    keptCallables = ImmutableArray.CreateBuilder[VariableSymbol]()
                    for var j = 0; j < i; j++ {
                        keptCallables.Add(callables[j])
                    }
                }
            } else if keptCallables != nil {
                keptCallables.Add(callables[i])
            }
        }
        if keptPaths == nil && keptCallables == nil {
            return this
        }
        return NarrowingState(
            if keptPaths == nil {
                paths
            } else {
                keptPaths.ToImmutable()
            },
            if keptTypes == nil {
                types
            } else {
                keptTypes.ToImmutable()
            },
            if keptCallables == nil {
                callables
            } else {
                keptCallables.ToImmutable()
            },
            false
        )
    }

    shared {
        /// Gets the state with no facts at a reachable point.
        prop Empty NarrowingState -> emptyState

        /// Gets the bottom state. It is the identity of (cref:Join) and the exit
        /// state of `return`, `throw`, `goto`, `break` and `continue`.
        prop Unreachable NarrowingState -> unreachableState

        private let emptyState NarrowingState = NarrowingState(
            ImmutableArray[AccessPath].Empty,
            ImmutableArray[TypeSymbol].Empty,
            ImmutableArray[VariableSymbol].Empty,
            false
        )
        private let unreachableState NarrowingState = NarrowingState(
            ImmutableArray[AccessPath].Empty,
            ImmutableArray[TypeSymbol].Empty,
            ImmutableArray[VariableSymbol].Empty,
            true
        )

        /// Builds a state from the facts of an ordered frame stack. The
        /// innermost frame that holds a path wins, like the frame query.
        /// @param frames The frames, outermost first.
        /// @param callables The variables that definitely hold an external callable.
        func FromFrames(frames IReadOnlyList[NarrowingFrame], callables IEnumerable[VariableSymbol]) NarrowingState {
            var result = Empty
            for frame in frames {
                for fact in frame {
                    result = result.With(fact.Key, fact.Value)
                }
            }
            for callable in callables {
                result = result.WithExternalCallable(callable)
            }
            return result
        }

        /// Merge (ADR-0208 section 6) over ALL predecessors of a merge point
        /// at once. A path that every reachable predecessor holds survives
        /// with the incoming type that every other incoming type converts to,
        /// else with its declared non-null type (cref:JoinTypes). A path that
        /// some predecessor lacks is dropped. External-callable facts intersect.
        /// Unreachable predecessors are skipped. Callers must not fold this
        /// pairwise: the result for `Dog`, `Cat` and `Animal` on `x object?`
        /// is `Animal`, while a binary fold gives `object`.
        /// @param predecessors The incoming states, in source order.
        func Join(predecessors IReadOnlyList[NarrowingState]) NarrowingState {
            let reachable = List[NarrowingState]()
            for predecessor in predecessors {
                if !predecessor.IsUnreachable {
                    reachable.Add(predecessor)
                }
            }
            if reachable.Count == 0 {
                return Unreachable
            }
            if reachable.Count == 1 {
                return reachable[0]
            }
            let first = reachable[0]
            var result = Empty
            for var i = 0; i < first.paths.Length; i++ {
                let incomingTypes = List[TypeSymbol](reachable.Count)
                incomingTypes.Add(first.types[i])
                var everywhere = true
                for var p = 1; p < reachable.Count; p++ {
                    let index = reachable[p].IndexOf(first.paths[i])
                    if index < 0 {
                        everywhere = false
                        break
                    }
                    incomingTypes.Add(reachable[p].types[index])
                }
                if !everywhere {
                    continue
                }
                let joined TypeSymbol? = JoinTypes(first.paths[i], incomingTypes)
                if joined != nil {
                    result = result.With(first.paths[i], joined)
                }
            }
            for callable in first.callables {
                if reachable.All((state NarrowingState) -> state.callables.Contains(callable)) {
                    result = result.WithExternalCallable(callable)
                }
            }
            return result
        }

        /// The type of one path after a join (ADR-0069 issue #4989 addendum and
        /// ADR-0208 amendment A1): the first incoming type that every incoming
        /// type converts to without changing representation, else the declared
        /// non-null type of the path (cref:DeclaredNonNullType).
        /// Every incoming type is a fact, so the declared type is always sound.
        /// The forward-`goto` join and the shadow join share this one rule.
        /// @param path The joined path.
        /// @param sourceTypes The incoming types, in source order.
        func JoinTypes(path AccessPath, sourceTypes IReadOnlyList[TypeSymbol]) TypeSymbol? {
            if sourceTypes.Count == 0 {
                return nil
            }
            let commonType TypeSymbol? = sourceTypes.FirstOrDefault(
                (candidate TypeSymbol) -> sourceTypes.All(
                    (source TypeSymbol) -> Conversion.IsRepresentationPreservingImplicit(source, candidate)
                )
            )
            if commonType != nil {
                return commonType
            }
            return DeclaredNonNullType(path)
        }

        /// The declared type of the storage that [`path`](paramref) names, with
        /// one nullable layer removed (ADR-0208 section 6, amendment A1). A plain
        /// root gives its own type. A member path gives the type of its last
        /// link, read from the source symbol or through the CLR nullability
        /// reader. A member whose declared type names a type parameter, or
        /// whose CLR declaring type is generic, gives `nil`, because the
        /// path does not record the receiver's type arguments.
        /// @param path The path.
        /// @returns The declared non-null type, or `nil` when it is not known.
        func DeclaredNonNullType(path AccessPath) TypeSymbol? {
            var declared TypeSymbol? = path.Root.Type
            if path.HasMembers {
                declared = DeclaredTypeOfLink(path.Members[path.Members.Length - 1])
                if declared == nil || TypeSymbol.ContainsTypeParameter(declared) {
                    return nil
                }
            }
            if declared is NullableTypeSymbol nullable {
                return nullable.UnderlyingType
            }
            return declared
        }

        private func DeclaredTypeOfLink(link PathMember) TypeSymbol? {
            if link.SourceSymbol is FieldSymbol field {
                return field.Type
            }
            if link.SourceSymbol is PropertySymbol property {
                return property.Type
            }
            if link.ClrMember is FieldInfo clrField && clrField.DeclaringType?.IsGenericType != true {
                return ClrNullability.GetFieldTypeSymbol(clrField)
            }
            if link.ClrMember is PropertyInfo clrProperty && clrProperty.DeclaringType?.IsGenericType != true {
                return ClrNullability.GetPropertyTypeSymbol(clrProperty)
            }
            return nil
        }
    }
}
