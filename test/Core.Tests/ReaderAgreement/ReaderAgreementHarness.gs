// <copyright file="ReaderAgreementHarness.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.ReaderAgreement

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Emit
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Symbols.Display
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics
import System.Globalization
import System.IO
import System.Linq
import System.Reflection
import System.Text
import Xunit.Abstractions

/// ADR-0193 §4: the reader-agreement differential. For every public member of
/// every generic type (and every public generic method) in a corpus, closes
/// the declaration over a small argument set and computes each signature
/// position through every Layer 1 reader that applies to that closing, then
/// asserts the readers agree on the position's nullability <em>shape</em> —
/// (cref:TypeSymbol.ReferenceNullability) at every position
/// (cref:TypeSymbol.GetElementPositions) enumerates.
///
/// The readers, and which arguments each can see:
/// ```xmldoc
/// <list type="table">
/// <listheader><term>Reader</term><description>What it is</description></listheader>
/// <item><term><c>direct</c></term><description><c>ClrNullability.Get*TypeSymbol</c> over the
/// erased closed member — what gsc reads for a plain imported receiver.</description></item>
/// <item><term><c>projection</c></term><description><c>ClrNullability.SymbolFromLayoutFlags</c>:
/// the open declaration's flags projected onto the erased closing.</description></item>
/// <item><term><c>merge-symbolic</c></term><description>The merge over
/// <c>MemberLookup.MapOpenClrTypeToSymbolic</c> of the symbolic closing
/// (receiver and method type arguments).</description></item>
/// <item><term><c>member-symbolic</c></term><description><c>MemberLookup.GetClr*TypeSymbol</c>
/// over a symbolic receiver (non-generic members of generic types).</description></item>
/// <item><term><c>lazy-symbolic</c></term><description>The lazy accessor
/// (<see cref="NullabilityAnnotatedTypeSymbol" />) over the symbolic projection,
/// carrying the projection reader's flags — the projection at a symbolic closing.</description></item>
/// <item><term><c>symbolic-call</c></term><description><c>MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs</c>
/// (generic-method returns) — the known gap, allowlisted.</description></item>
/// </list>
/// ```
/// The CLR readers (`direct`, `projection`)
/// can only close over a CLR type, which states no reference nullability, so
/// they run only for the erasure-faithful arguments (`string`,
/// `int32`, `List[string]`). `string?` and an in-scope type
/// parameter reach the symbolic readers only.
///
/// Every (cref:NullabilityAnnotatedTypeSymbol) any reader returns is
/// also cross-checked: its two lazy accessors
/// ((cref:NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbol) and
/// (cref:NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbolForClrType))
/// must agree at every argument they can both address.
internal class ReaderAgreementHarness {
    private let resolver ReferenceResolver
    private let corpusName string
    private let disagreements List[Disagreement] = List[Disagreement]()
    private let readerExceptions Dictionary[string, int32] = Dictionary[string, int32](StringComparer.Ordinal)
    private let arguments ImmutableArray[ArgumentSpec]
    private var typesVisited int32
    private var membersVisited int32
    private var positionsCompared int32
    private var readerCalls int32
    private var closingsSkipped int32
    private var enumerationErrors int32

    internal init(resolver ReferenceResolver, corpusName string) {
        this.resolver = resolver
        this.corpusName = corpusName
        this.arguments = BuildArguments(resolver)
    }

    internal prop Disagreements IReadOnlyList[Disagreement] -> this.disagreements

    /// Gets how many reader calls threw. A throwing reader drops out of the
    /// comparison, which would let a position "agree" with fewer voters, so
    /// the test requires this to be zero.
    internal prop ReaderExceptionCount int32 -> this.readerExceptions.Values.Sum()

    /// Gets how many times enumerating the corpus itself failed — an assembly's
    /// types, a type's members, a closed member's counterpart, or a signature
    /// that names a type the corpus cannot resolve. Each one silently shrinks
    /// the corpus, so the test requires this to be zero too.
    internal prop EnumerationErrorCount int32 -> this.enumerationErrors

    /// Gets how many position closings were compared.
    internal prop PositionsCompared int32 -> this.positionsCompared

    /// Runs the differential over every public generic declaration in [`assemblies`](paramref).
    /// @param assemblies The corpus.
    /// @returns The run's summary line.
    internal func Run(assemblies IEnumerable[Assembly]) string {
        let stopwatch = Stopwatch.StartNew()
        {
            using let _ = NullabilityOptions.Enter(NullabilityMode.PlatformTypes)
            for assembly in assemblies {
                for type in SafeGetExportedTypes(assembly) {
                    this.VisitType(type)
                }
            }
        }
        stopwatch.Stop()
        let exceptions = if this.readerExceptions.Count == 0 {
            "none"
        } else {
            string.Join(
                ", ",
                this
                    .readerExceptions
                    .OrderBy((p KeyValuePair[string, int32]) -> p.Key, StringComparer.Ordinal)
                    .Select((p KeyValuePair[string, int32]) -> "${p.Key}=${p.Value}")
            )
        }
        return "${this.corpusName}: ${this.typesVisited} types, ${this.membersVisited} members, " +
            "${this.positionsCompared} position closings compared, ${this.readerCalls} reader calls, " +
            "${this.closingsSkipped} closings skipped (constraints), ${this.enumerationErrors} enumeration errors, ${this.disagreements.Count} disagreements, " +
            "reader exceptions: $exceptions; ${stopwatch.Elapsed.TotalSeconds:F1}s"
    }

    private func SafeGetExportedTypes(assembly Assembly) sequence[Type] {
        var types[]Type
        try {
            types = assembly.GetExportedTypes()
        } catch (exception ReflectionTypeLoadException) {
            this.enumerationErrors++
            types = exception.Types.OfType[Type]().ToArray()
        } catch (Exception) {
            this.enumerationErrors++
            yield break
        }
        for type in types.OrderBy((t Type) -> t.FullName, StringComparer.Ordinal) {
            yield type
        }
    }

    private func VisitType(type Type) {
        if type.IsGenericTypeDefinition {
            this.typesVisited++
            for member in SafeGetMembers(type) {
                this.VisitMember(type, member)
            }
            return
        }
        var visited = false
        for method in SafeGetMethods(type) {
            if !method.IsGenericMethodDefinition {
                continue
            }
            if !visited {
                this.typesVisited++
                visited = true
            }
            this.VisitMember(type, method)
        }
    }

    private func SafeGetMembers(type Type) sequence[MemberInfo] {
        var members[]MemberInfo
        try {
            members = type.GetMembers(PublicMembers)
        } catch (Exception) {
            this.enumerationErrors++
            yield break
        }
        for member in members {
            if member is MethodInfo && member.IsSpecialName == true {
                // Accessors are reached through their property.
                continue
            }
            if (member is MethodInfo or ConstructorInfo or PropertyInfo or FieldInfo or EventInfo) {
                yield member
            }
        }
    }

    private func SafeGetMethods(type Type) sequence[MethodInfo] {
        var methods[]MethodInfo
        try {
            methods = type.GetMethods(PublicMembers)
        } catch (Exception) {
            this.enumerationErrors++
            yield break
        }
        for method in methods {
            yield method
        }
    }

    private func VisitMember(declaringDefinition Type, openMember MemberInfo) {
        this.membersVisited++
        for argument in this.arguments {
            try {
                this.VisitClosing(declaringDefinition, openMember, argument)
            } catch (exception Exception) when exception is TypeLoadException ||
                exception is FileNotFoundException ||
                exception is NotSupportedException {
                // A member whose signature names a type the corpus cannot
                // resolve cannot be read by ANY reader. It is not a
                // disagreement, but it is a hole in the corpus, so it counts.
                this.enumerationErrors++
            }
        }
    }

    private func VisitClosing(declaringDefinition Type, openMember MemberInfo, argument ArgumentSpec) {
        var closedType = declaringDefinition
        var typeArguments = ImmutableArray[TypeSymbol].Empty
        if declaringDefinition.IsGenericTypeDefinition {
            if !TryClose(declaringDefinition, argument, out closedType) {
                this.closingsSkipped++
                return
            }
            typeArguments = ImmutableArray.CreateRange(
                Enumerable.Repeat(argument.Symbolic, declaringDefinition.GetGenericArguments().Length)
            )
        }
        var closedMember MemberInfo? = FindClosedMember(closedType, openMember)
        if closedMember == nil {
            // Every public member of an open definition has a counterpart on
            // its closing; not finding one means the corpus shrank.
            this.enumerationErrors++
            return
        }
        var methodArguments = default(ImmutableArray[TypeSymbol?])
        var openMethod MethodInfo? = nil
        if openMember is MethodInfo{IsGenericMethodDefinition: true} genericOpen {
            let closedDefinition = cast[MethodInfo](closedMember)
            if !TryClose(closedDefinition, argument, out var closedMethod) {
                this.closingsSkipped++
                return
            }
            closedMember = closedMethod
            openMethod = genericOpen
            methodArguments = ImmutableArray.CreateRange(
                Enumerable.Repeat[TypeSymbol?](argument.Symbolic, genericOpen.GetGenericArguments().Length)
            )
        }
        let receiver = if declaringDefinition.IsGenericTypeDefinition {
            ImportedTypeSymbol.GetConstructed(closedType, declaringDefinition, typeArguments)
        } else {
            default(ImportedTypeSymbol?)
        }
        let context = ClosingContext(
            declaringDefinition,
            openMember,
            closedMember!!,
            argument,
            typeArguments,
            openMethod,
            methodArguments,
            receiver
        )
        switch openMember {
            case open_ is MethodInfo {
                let closed = cast[MethodInfo](closedMember!!)
                if !IsVoid(open_.ReturnType) {
                    this.ComparePosition(context, "return", Position.Return(open_, closed))
                }
                this.CompareParameters(
                    context,
                    open_.GetParameters(),
                    (cast[MethodBase](closedMember!!)).GetParameters(),
                    open_
                )
            }
            case open_ is ConstructorInfo {
                this.CompareParameters(
                    context,
                    open_.GetParameters(),
                    (cast[MethodBase](closedMember!!)).GetParameters(),
                    open_
                )
            }
            case open_ is PropertyInfo {
                let closedProperty = cast[PropertyInfo](closedMember!!)
                this.ComparePosition(context, "property", Position.Property(open_, closedProperty))
                let openIndexParameters = open_.GetIndexParameters()
                let closedIndexParameters = closedProperty.GetIndexParameters()
                for var i = 0; i < openIndexParameters.Length && i < closedIndexParameters.Length; i++ {
                    this.ComparePosition(
                        context,
                        "index parameter $i (${openIndexParameters[i].Name})",
                        Position.IndexParameter(
                            openIndexParameters[i],
                            closedIndexParameters[i],
                            open_,
                            closedProperty,
                            i
                        )
                    )
                }
            }
            case open_ is FieldInfo {
                this.ComparePosition(context, "field", Position.Field(open_, cast[FieldInfo](closedMember!!)))
            }
            case open_ is EventInfo when open_.EventHandlerType != nil &&
                (cast[EventInfo](closedMember!!)).EventHandlerType != nil {
                this.ComparePosition(context, "event", Position.Event(open_, cast[EventInfo](closedMember!!)))
            }
        }
    }

    private func CompareParameters(
        context ClosingContext,
        openParameters[]ParameterInfo,
        closedParameters[]ParameterInfo,
        openMethod MethodBase
    ) {
        for var i = 0; i < openParameters.Length && i < closedParameters.Length; i++ {
            this.ComparePosition(
                context,
                "parameter $i (${openParameters[i].Name})",
                Position.Parameter(openParameters[i], closedParameters[i], openMethod, i)
            )
        }
    }

    private func FindClosedMember(closedType Type, openMember MemberInfo) MemberInfo? {
        if object.ReferenceEquals(closedType, openMember.DeclaringType) {
            return openMember
        }
        try {
            for candidate in closedType.GetMembers(PublicMembers) {
                if candidate.MetadataToken == openMember.MetadataToken &&
                    candidate.MemberType == openMember.MemberType {
                    return candidate
                }
            }
        } catch (Exception) {
            this.enumerationErrors++
        }
        return nil
    }

    private func ComparePosition(context ClosingContext, positionName string, position Position) {
        let shapes = List[(Reader string, Shape string, Display string)]()
        let openType = StripByRef(position.OpenType)
        let closedType = StripByRef(position.ClosedType)
        let flags = Flags(position.OpenProvider, position.OpenEnclosing)
        let isGenericMethod = context.OpenMethod != nil
        if context.Argument.ErasureFaithful {
            this.Read(shapes, position, "direct", position.Direct)
            this.Read(
                shapes,
                position,
                "projection",
                func () TypeSymbol? {
                    return ClrNullability.SymbolFromLayoutFlags(closedType, openType, flags)
                }
            )
        }
        this.Read(
            shapes,
            position,
            "merge-symbolic",
            func () TypeSymbol? {
                return NullableFlagsBuilder.MergeDeclarationNullability(
                    this.MapSymbolic(context, openType),
                    openType,
                    flags
                )
            }
        )
        if context.Receiver != nil && !isGenericMethod && position.MemberSymbolic != nil {
            this.Read(
                shapes,
                position,
                "member-symbolic",
                func () TypeSymbol? {
                    return position.MemberSymbolic!!(context.Receiver!!)
                }
            )
        }
        // Not for the in-scope type parameter: the lazy accessor decodes flags
        // against its CLR shape, and a symbolic `T`'s erased shape is
        // `object` — a Reference — so the flags can only say what they would
        // for `object`. gsc never builds that pairing: a symbolic base under
        // a lazy wrapper keeps the CLR generic parameter as its argument
        // (`Binder.RemapImportedMethodTypeParameters`), which the merge reads
        // as an open slot.
        if closedType.IsConstructedGenericType &&
            !(context.Argument.Symbolic is TypeParameterSymbol) &&
            !closedType.IsValueType &&
            this.MapSymbolic(context, openType) is ImportedTypeSymbol{
            TypeArguments: {IsDefaultOrEmpty: false}
        } symbolicBase {
            this.Read(
                shapes,
                position,
                "lazy-symbolic",
                func () TypeSymbol? {
                    let projected = if ClrTypeUtilities.AreSame(closedType, openType) {
                        flags
                    } else {
                        ClrNullability.ProjectNullableFlags(closedType, openType, flags)
                    }
                    let annotated = NullabilityAnnotatedTypeSymbol(symbolicBase, projected)
                    return ClrNullability.SymbolForState(annotated, ClrNullability.ClassifyPosition(projected, 0))
                }
            )
        }
        if isGenericMethod && positionName == "return" {
            this.Read(
                shapes,
                position,
                "symbolic-call",
                () -> MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(
                    cast[MethodInfo](context.ClosedMember),
                    context.MethodArguments,
                    context.Receiver
                )
            )
        }
        if shapes.Count == 0 {
            return
        }
        this.positionsCompared++
        let distinct = shapes
            .Select((s(Reader string, Shape string, Display string)) -> s.Shape)
            .Distinct(StringComparer.Ordinal)
            .Count()
        if distinct > 1 {
            this.disagreements.Add(
                Disagreement(
                    this.corpusName,
                    MemberName(context.OpenMember),
                    context.OpenMember.ToString() ?? context.OpenMember.Name,
                    positionName,
                    context.Argument.Name,
                    shapes.Select(
                        (s(Reader string, Shape string, Display string)) -> ReaderResult(s.Reader, s.Shape, s.Display)
                    )
                        .ToImmutableArray(),
                    openType,
                    Tags(
                        openType,
                        position,
                        shapes.Select((r(Reader string, Shape string, Display string)) -> r.Shape).ToList()
                    )
                )
            )
        }
    }

    private func MapSymbolic(context ClosingContext, openType Type) TypeSymbol -> MemberLookup.MapOpenClrTypeToSymbolic(
        openType,
        if context.DeclaringDefinition.IsGenericTypeDefinition {
            context.DeclaringDefinition
        } else {
            default(Type?)
        },
        context.TypeArguments,
        context.OpenMethod,
        context.MethodArguments
    )

    private func Read(
        shapes List[(Reader string, Shape string, Display string)],
        position Position,
        reader string,
        read() -> TypeSymbol?
    ) {
        this.readerCalls++
        var result TypeSymbol?
        try {
            result = read()
        } catch (exception Exception) when !(exception is OutOfMemoryException) {
            let key = "$reader:${exception.GetType().Name}"
            this.readerExceptions[key] = if this.readerExceptions.TryGetValue(key, out var count) {
                count + 1
            } else {
                1
            }
            return
        }
        if result == nil {
            return
        }
        if position.StripRootNullable && result is NullableTypeSymbol nullableRoot {
            // An event's handler has no nullability of its own to compare:
            // every event reader strips a top-level `?` (the handler delegate
            // field is always nullable), so the comparison does too.
            result = nullableRoot.UnderlyingType
        }
        shapes.Add((reader, Shape(result!!), Describe(result!!)))
        this.CrossCheckLazyAccessors(reader, result!!)
    }

    /// The lazy accessor's two entry points must agree wherever both can
    /// address an argument. Recorded as its own reader pair on the same
    /// position so a disagreement names which accessor drifted.
    private func CrossCheckLazyAccessors(reader string, root TypeSymbol) {
        let pending = Stack[(Type TypeSymbol, Depth int32)]()
        pending.Push((root, 0))
        while pending.Count > 0 {
            let (current, depth) = pending.Pop()
            if depth > 8 {
                continue
            }
            if current is NullabilityAnnotatedTypeSymbol annotated &&
                annotated.ClrType is {IsGenericType: true, IsGenericTypeDefinition: false} clr {
                let clrArguments = clr.GetGenericArguments()
                for var i = 0; i < clrArguments.Length; i++ {
                    if clrArguments.Count((a Type) -> ClrTypeUtilities.AreSame(a, clrArguments[i])) != 1 {
                        continue
                    }
                    let byIndex = Shape(annotated.GetTypeArgumentSymbol(i))
                    let byClrType = Shape(annotated.GetTypeArgumentSymbolForClrType(clrArguments[i]))
                    if !string.Equals(byIndex, byClrType, StringComparison.Ordinal) {
                        this.disagreements.Add(
                            Disagreement(
                                this.corpusName,
                                "$reader lazy accessors",
                                Describe(annotated),
                                "type argument $i",
                                string.Empty,
                                ImmutableArray.Create(
                                    ReaderResult("lazy-index", byIndex, string.Empty),
                                    ReaderResult("lazy-clrtype", byClrType, string.Empty)
                                ),
                                clr,
                                ImmutableArray[string].Empty
                            )
                        )
                    }
                }
            }
            for position in SafePositions(current) {
                pending.Push((position, depth + 1))
            }
        }
    }

    private func SafePositions(type TypeSymbol) ImmutableArray[TypeSymbol] {
        try {
            return type.GetElementPositions()
        } catch (Exception) {
            this.enumerationErrors++
            return ImmutableArray[TypeSymbol].Empty
        }
    }

    /// A parsed (cref:Shape(TypeSymbol)) string.
    private class ShapeNode {
        private init(root char, children List[ShapeNode]) {
            this.Root = root
            this.Children = children
        }

        internal prop Root char {
            get;
        }

        internal prop Children List[ShapeNode] {
            get;
        }

        shared {
            internal func Parse(shape string) ShapeNode {
                var index = 0
                let Read = func () ShapeNode {
                    let root = shape[index++]
                    let children = List[ShapeNode]()
                    if index < shape.Length && shape[index] == '<' {
                        index++
                        while true {
                            children.Add(Read())
                            let separator = shape[index++]
                            if separator == '>' {
                                break
                            }
                        }
                    } else if index < shape.Length && shape[index] == '…' {
                        index++
                    }
                    return ShapeNode(root, children)
                }
                return Read()
            }
        }
    }

    internal data class ArgumentSpec(Name string, Erased Type, Symbolic TypeSymbol, ErasureFaithful bool) : IEquatable[
        ArgumentSpec
    ] { }

    internal data class ReaderResult(Reader string, Shape string, Display string) : IEquatable[ReaderResult] { }

    /// One position where the readers produced more than one shape.
    /// @param Corpus The corpus name.
    /// @param Member The declaring type and member name.
    /// @param MemberSignature The member's reflected signature.
    /// @param PositionName Which signature position.
    /// @param Argument Which closing argument.
    /// @param Results Each reader's shape.
    /// @param OpenPositionType The open declaration's type at the position.
    /// @param Tags Facts about the position an allowlist entry can match ((cref:Tags(Type, Position))).
    internal data class Disagreement(
        Corpus string,
        Member string,
        MemberSignature string,
        PositionName string,
        Argument string,
        Results ImmutableArray[ReaderResult],
        OpenPositionType Type,
        Tags ImmutableArray[string]
    ) : IEquatable[Disagreement] {
        /// Gets the readers in the minority — the ones whose shape differs from
        /// the most common shape. For a tie, every reader not in the first
        /// group. This is what an allowlist entry matches.
        internal prop Dissenters ImmutableArray[string] {
            get {
                let majority = this
                    .Results
                    .GroupBy((r ReaderResult) -> r.Shape, StringComparer.Ordinal)
                    .OrderByDescending((g IGrouping[string, ReaderResult]) -> g.Count())
                    .ThenBy(
                    (g IGrouping[string, ReaderResult]) -> g.Min((r ReaderResult) -> r.Reader),
                    StringComparer.Ordinal
                )
                    .First()
                    .Key
                return this
                    .Results
                    .Where((r ReaderResult) -> !string.Equals(r.Shape, majority, StringComparison.Ordinal))
                    .Select((r ReaderResult) -> r.Reader)
                    .OrderBy((r string) -> r, StringComparer.Ordinal)
                    .ToImmutableArray()
            }
        }

        /// Gets a grouping key: the dissenting readers and the argument.
        internal prop Signature string -> "dissent[${string.Join("+", this.Dissenters)}] arg=${this.Argument} pos=${(if this.PositionName.StartsWith("parameter", StringComparison.Ordinal) { "parameter" } else { this.PositionName })}"

        /// ```xmldoc
        /// <inheritdoc />
        /// ```
        override func ToString() string -> "${this.Corpus} ${this.Member} [${this.MemberSignature}] ${this.PositionName} @ ${this.Argument}: " +
            string.Join("; ", this.Results.Select((r ReaderResult) -> "${r.Reader}=${r.Shape} (${r.Display})"))
    }

    private data class ClosingContext(
        DeclaringDefinition Type,
        OpenMember MemberInfo,
        ClosedMember MemberInfo,
        Argument ArgumentSpec,
        TypeArguments ImmutableArray[TypeSymbol],
        OpenMethod MethodInfo?,
        MethodArguments ImmutableArray[TypeSymbol?],
        Receiver ImportedTypeSymbol?
    ) : IEquatable[ClosingContext] { }

    /// One signature position, with the readers that are specific to its member kind.
    private data class Position(
        OpenType Type,
        ClosedType Type,
        OpenProvider ICustomAttributeProvider,
        OpenEnclosing MemberInfo,
        Direct() -> TypeSymbol,
        MemberSymbolic((TypeSymbol) -> TypeSymbol)?,
        OptionalNullDefault bool = false,
        StripRootNullable bool = false
    ) : IEquatable[Position] {
        shared {
            internal func Return($open MethodInfo, closed MethodInfo) Position -> Position(
                $open.ReturnType,
                closed.ReturnType,
                $open.ReturnParameter,
                $open,
                () -> ClrNullability.GetReturnTypeSymbol(closed),
                (receiver TypeSymbol) -> MemberLookup.GetClrMethodReturnTypeSymbol(receiver, closed)
            )

            internal func Parameter(
                $open ParameterInfo,
                closed ParameterInfo,
                openMethod MethodBase,
                index int32
            ) Position -> Position(
                $open.ParameterType,
                closed.ParameterType,
                $open,
                openMethod,
                () -> ClrNullability.GetParameterTypeSymbol(closed),
                if closed.Member is MethodInfo closedMethod {
                    (receiver TypeSymbol) -> MemberLookup.GetClrMethodParameterTypeSymbol(receiver, closedMethod, index)
                } else {
                    default(((TypeSymbol) -> TypeSymbol)?)
                },
                HasOptionalNullDefault(closed)
            )

            /// The condition under which `ClrNullability.GetParameterTypeSymbol`
            /// lifts a reference parameter to `T?` for its `null` default.
            private func HasOptionalNullDefault(parameter ParameterInfo) bool {
                try {
                    let type = if parameter.ParameterType.IsByRef {
                        parameter.ParameterType.GetElementType()
                    } else {
                        parameter.ParameterType
                    }
                    if type?.IsValueType != false || !(parameter.HasDefaultValue || parameter.IsOptional) {
                        return false
                    }
                    let value object? = parameter.RawDefaultValue
                    return value == nil || object.ReferenceEquals(value, Missing.Value) || object.ReferenceEquals(
                        value,
                        DBNull.Value
                    )
                } catch (exception Exception) when exception is FormatException ||
                    exception is InvalidOperationException ||
                    exception is NotSupportedException {
                    return false
                }
            }

            internal func IndexParameter(
                $open ParameterInfo,
                closed ParameterInfo,
                openIndexer PropertyInfo,
                closedIndexer PropertyInfo,
                index int32
            ) Position -> Position(
                $open.ParameterType,
                closed.ParameterType,
                $open,
                openIndexer,
                () -> ClrNullability.GetParameterTypeSymbol(closed),
                (receiver TypeSymbol) -> MemberLookup.GetIndexerParameterTypeSymbol(receiver, closedIndexer, index),
                HasOptionalNullDefault(closed)
            )

            internal func Property($open PropertyInfo, closed PropertyInfo) Position -> Position(
                $open.PropertyType,
                closed.PropertyType,
                $open,
                Invariant.Required(
                    $open.DeclaringType,
                    "a property has a declaring type",
                    expression: "open.DeclaringType"
                ),
                () -> ClrNullability.GetPropertyTypeSymbol(closed),
                (receiver TypeSymbol) -> MemberLookup.GetClrPropertyTypeSymbol(receiver, closed)
            )

            internal func Event($open EventInfo, closed EventInfo) Position -> Position(
                Invariant.Required(
                    $open.EventHandlerType,
                    "the caller checked the handler type",
                    expression: "open.EventHandlerType"
                ),
                Invariant.Required(
                    closed.EventHandlerType,
                    "the caller checked the handler type",
                    expression: "closed.EventHandlerType"
                ),
                $open,
                Invariant.Required(
                    $open.DeclaringType,
                    "an event has a declaring type",
                    expression: "open.DeclaringType"
                ),
                () -> MemberLookup.GetClrEventHandlerTypeSymbol(closed),
                (receiver TypeSymbol) -> MemberLookup.GetClrEventHandlerTypeSymbol(receiver, closed),
                StripRootNullable: true
            )

            internal func Field($open FieldInfo, closed FieldInfo) Position -> Position(
                $open.FieldType,
                closed.FieldType,
                $open,
                Invariant.Required(
                    $open.DeclaringType,
                    "a field has a declaring type",
                    expression: "open.DeclaringType"
                ),
                () -> ClrNullability.GetFieldTypeSymbol(closed),
                (receiver TypeSymbol) -> MemberLookup.GetClrFieldTypeSymbol(receiver, closed)
            )
        }
    }

    shared {
        private const PublicMembers BindingFlags = BindingFlags.Public | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly

        /// Renders a type's nullability shape: the root's
        /// (cref:TypeSymbol.ReferenceNullability) (`n`, `?`,
        /// `!`, or `v` for not-applicable) followed by its
        /// (cref:TypeSymbol.GetElementPositions), recursively.
        /// @param type The type.
        /// @returns The shape.
        internal func Shape(type TypeSymbol) string {
            let builder = StringBuilder()
            let Append = func (current TypeSymbol, depth int32) {
                builder.Append(
                    switch current.ReferenceNullability {
                        case ReferenceNullabilityKind.NotNull: 'n'
                        case ReferenceNullabilityKind.Nullable: '?'
                        case ReferenceNullabilityKind.Platform: '!'
                        default: 'v'
                    }
                )
                if depth > 12 {
                    builder.Append('…')
                    return
                }
                let positions = current.GetElementPositions()
                if positions.IsDefaultOrEmpty {
                    return
                }
                builder.Append('<')
                for var i = 0; i < positions.Length; i++ {
                    if i > 0 {
                        builder.Append(',')
                    }
                    Append(positions[i], depth + 1)
                }
                builder.Append('>')
            }
            Append(type, 0)
            return builder.ToString()
        }

        private func BuildArguments(resolver ReferenceResolver) ImmutableArray[ArgumentSpec] {
            let stringType = resolver.GetCoreType("System.String")
            let intType = resolver.GetCoreType("System.Int32")
            let objectType = resolver.GetCoreType("System.Object")
            let builder = ImmutableArray.CreateBuilder[ArgumentSpec]()
            builder.Add(ArgumentSpec("string", stringType, TypeSymbol.String, ErasureFaithful: true))
            builder.Add(
                ArgumentSpec("string?", stringType, NullableTypeSymbol.Get(TypeSymbol.String), ErasureFaithful: false)
            )
            builder.Add(ArgumentSpec("int32", intType, TypeSymbol.Int32, ErasureFaithful: true))
            if resolver.TryResolveType("System.Collections.Generic.List`1", out var listDefinition) {
                let listOfString = listDefinition.MakeGenericType(stringType)
                builder.Add(
                    ArgumentSpec(
                        "List[string]",
                        listOfString,
                        ImportedTypeSymbol.GetConstructed(
                            listOfString,
                            listDefinition,
                            ImmutableArray.Create(TypeSymbol.String)
                        ),
                        ErasureFaithful: true
                    )
                )
            }
            builder.Add(
                ArgumentSpec(
                    "T",
                    objectType,
                    TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None),
                    ErasureFaithful: false
                )
            )
            return builder.ToImmutable()
        }

        private func TryClose(definition Type, argument ArgumentSpec, out closed Type) bool {
            closed = definition
            if !SatisfiesConstraints(definition.GetGenericArguments(), argument) {
                return false
            }
            try {
                closed = definition.MakeGenericType(
                    Enumerable.Repeat(argument.Erased, definition.GetGenericArguments().Length).ToArray()
                )
                return true
            } catch (ArgumentException) {
                // The one genuine skip: the argument violates a constraint.
                return false
            }
        }

        private func TryClose(definition MethodInfo, argument ArgumentSpec, out closed MethodInfo) bool {
            closed = definition
            if !SatisfiesConstraints(definition.GetGenericArguments(), argument) {
                return false
            }
            try {
                closed = definition.MakeGenericMethod(
                    Enumerable.Repeat(argument.Erased, definition.GetGenericArguments().Length).ToArray()
                )
                return true
            } catch (ArgumentException) {
                // The one genuine skip: the argument violates a constraint.
                return false
            }
        }

        /// A (cref:System.Reflection.MetadataLoadContext) does not validate
        /// generic constraints in `MakeGenericType`, so the harness does. The
        /// in-scope type parameter is unconstrained, so it only closes a slot that
        /// carries no constraint at all.
        private func SatisfiesConstraints(parameters[]Type, argument ArgumentSpec) bool {
            let Substitute = func (type Type, argument Type) Type {
                if type.IsGenericParameter {
                    return argument
                }
                if type.IsArray {
                    let element = Substitute(
                        Invariant.Required(
                            type.GetElementType(),
                            "an array has an element type",
                            expression: "type.GetElementType()"
                        ),
                        argument
                    )
                    return if type.GetArrayRank() == 1 {
                        element.MakeArrayType()
                    } else {
                        element.MakeArrayType(type.GetArrayRank())
                    }
                }
                if type.IsGenericType && type.ContainsGenericParameters {
                    return type.GetGenericTypeDefinition().MakeGenericType(
                        type.GetGenericArguments().Select((a Type) -> Substitute(a, argument)).ToArray()
                    )
                }
                return type
            }
            try {
                let candidate = argument.Erased
                for parameter in parameters {
                    let special = parameter.GenericParameterAttributes & GenericParameterAttributes.SpecialConstraintMask
                    let constraints = parameter.GetGenericParameterConstraints()
                    if argument.Symbolic is TypeParameterSymbol {
                        if special != GenericParameterAttributes.None || constraints.Length > 0 {
                            return false
                        }
                        continue
                    }
                    if (special & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0 &&
                        (!candidate.IsValueType || NullableLifting.IsValueTypeNullableClr(candidate)) {
                        return false
                    }
                    if (special & GenericParameterAttributes.ReferenceTypeConstraint) != 0 && candidate.IsValueType {
                        return false
                    }
                    if (special & GenericParameterAttributes.DefaultConstructorConstraint) != 0 &&
                        !candidate.IsValueType &&
                        candidate.GetConstructor(Type.EmptyTypes) == nil {
                        return false
                    }
                    for constraint in constraints {
                        if !Substitute(constraint, candidate).IsAssignableFrom(candidate) {
                            return false
                        }
                    }
                }
                return true
            } catch (exception Exception) when exception is ArgumentException ||
                exception is InvalidOperationException {
                // A constraint the argument cannot satisfy (MakeGenericType
                // rejecting the substituted constraint). Anything else — an
                // unresolvable constraint type, say — is not a constraint answer
                // but a hole in the corpus, and propagates to VisitMember, which
                // counts it as an enumeration error.
                return false
            }
        }

        private func StripByRef(type Type) Type -> if type.IsByRef {
            type.GetElementType() ?? type
        } else {
            type
        }

        private func Describe(type TypeSymbol) string {
            try {
                return SymbolDisplay.ToTypeDisplayString(type)
            } catch (Exception) {
                return type.Name
            }
        }

        private func MemberName(member MemberInfo) string -> "${member.DeclaringType?.FullName ?? "?"}::${member.Name}"

        private func Flags(provider ICustomAttributeProvider, enclosing MemberInfo) ImmutableArray[
            uint8
        ] -> ClrNullability.ReadNullableFlags(provider, enclosing)

        private func IsVoid(type Type) bool -> type.FullName == "System.Void"

        /// Facts about a position that an allowlist entry can match on, so an entry
        /// excuses one known cause rather than one reader everywhere.
        /// - `system-tuple`: the position mentions the reference type `System.Tuple<…>`.
        /// - `concrete-array-or-tuple`: the position contains an array or `ValueTuple` that mentions no type
        /// parameter.
        /// - `optional-null-default`: a reference parameter with a `null` default.
        private func Tags(openType Type, position Position, shapes IReadOnlyList[string]) ImmutableArray[string] {
            let IsSystemTuple = func (type Type) bool {
                return type.IsGenericType && GenericDefinitionName(type).StartsWith(
                    "System.Tuple`",
                    StringComparison.Ordinal
                )
            }
            let IsConcreteArrayOrValueTuple = func (type Type) bool {
                return !type.ContainsGenericParameters &&
                    (
                    type.IsArray ||
                        (
                        type.IsGenericType && GenericDefinitionName(type).StartsWith(
                            "System.ValueTuple`",
                            StringComparison.Ordinal
                        )
                    )
                )
            }
            let AllWithin = func (differing List[string], nodes List[string]) bool {
                return differing.Count > 0 && nodes.Count > 0 && differing.All(
                    (path string) -> nodes.Any(
                        (node string) -> node.Length == 0 || path == node || path.StartsWith(
                            node + "/",
                            StringComparison.Ordinal
                        )
                    )
                )
            }
            // A structural tag applies only when EVERY place the readers differ
            // lies inside a node of that kind, so a known cause in one subtree
            // cannot excuse an unrelated drift elsewhere in the same position.
            let differing = DifferingPaths(shapes)
            let tags = ImmutableArray.CreateBuilder[string]()
            if AllWithin(differing, NodePaths(openType, IsSystemTuple)) {
                tags.Add("system-tuple")
            }
            if AllWithin(differing, NodePaths(openType, IsConcreteArrayOrValueTuple)) {
                tags.Add("concrete-array-or-tuple")
            }
            if position.OptionalNullDefault {
                tags.Add("optional-null-default")
            }
            return tags.ToImmutable()
        }

        private func GenericDefinitionName(type Type) string -> (
            if type.IsGenericTypeDefinition {
                type
            } else {
                type.GetGenericTypeDefinition()
            }
        ).FullName ??
            string.Empty

        /// The paths (child indices joined by `/`, the root being empty) of
        /// every node of [`type`](paramref) that [`match`](paramref)
        /// selects, laid out exactly as (cref:TypeSymbol.GetElementPositions)
        /// lays positions out: `Nullable<V>` and by-ref are transparent,
        /// an array's one child is its element, and a canonical eight-argument
        /// tuple's rest is spliced in. A generic parameter is a leaf: whatever
        /// substitutes it hangs below the same path.
        private func NodePaths(type Type, match(Type) -> bool) List[string] {
            let Children = func (current Type) List[Type] {
                if current.IsGenericParameter {
                    return List[Type]()
                }
                if current.IsArray && current.GetElementType() is {} element {
                    return List[Type]{element}
                }
                if !current.IsGenericType {
                    return List[Type]()
                }
                let arguments = current.GetGenericArguments().ToList()
                let name = GenericDefinitionName(current)
                if arguments.Count == 8 &&
                    (name is "System.ValueTuple`8" or "System.Tuple`8") &&
                    arguments[7].IsGenericType &&
                    (
                    GenericDefinitionName(arguments[7]).StartsWith("System.ValueTuple`", StringComparison.Ordinal) ||
                        GenericDefinitionName(arguments[7]).StartsWith("System.Tuple`", StringComparison.Ordinal)
                ) {
                    let rest = arguments[7]
                    arguments.RemoveAt(7)
                    arguments.AddRange(Children(rest))
                }
                return arguments
            }
            let paths = List[string]()
            let Walk = func (current Type, path string) {
                if current.IsByRef && current.GetElementType() is {} referent {
                    Walk(referent, path)
                    return
                }
                if NullableLifting.GetValueTypeNullableUnderlyingClr(current) is {} underlying {
                    Walk(underlying, path)
                    return
                }
                if match(current) {
                    paths.Add(path)
                    return
                }
                let children = Children(current)
                for var i = 0; i < children.Count; i++ {
                    Walk(
                        children[i],
                        if path.Length == 0 {
                            i.ToString(CultureInfo.InvariantCulture)
                        } else {
                            path + "/" + i.ToString(CultureInfo.InvariantCulture)
                        }
                    )
                }
            }
            Walk(type, string.Empty)
            return paths
        }

        /// The minimal paths at which the readers' shapes differ: a node whose own
        /// nullability or child count differs between any two shapes is recorded
        /// and not descended into.
        private func DifferingPaths(shapes IReadOnlyList[string]) List[string] {
            let trees = shapes.Select(ShapeNode.Parse).ToList()
            let differing = List[string]()
            let Compare = func (nodes List[ShapeNode], path string) {
                if nodes
                    .Select((n ShapeNode) -> n.Root)
                    .Distinct()
                    .Count() > 1 ||
                    nodes
                    .Select((n ShapeNode) -> n.Children.Count)
                    .Distinct()
                    .Count() > 1 {
                    differing.Add(path)
                    return
                }
                for var i = 0; i < nodes[0].Children.Count; i++ {
                    let index = i
                    Compare(
                        nodes.Select((n ShapeNode) -> n.Children[index]).ToList(),
                        if path.Length == 0 {
                            i.ToString(CultureInfo.InvariantCulture)
                        } else {
                            path + "/" + i.ToString(CultureInfo.InvariantCulture)
                        }
                    )
                }
            }
            Compare(trees, string.Empty)
            return differing
        }

        /// Writes up to [`limit`](paramref) disagreements, grouped by the readers that dissent.
        /// @param output The test output.
        /// @param disagreements The disagreements to report.
        /// @param limit The maximum number of examples per group.
        internal func Report(output ITestOutputHelper, disagreements IEnumerable[Disagreement], limit int32 = 5) {
            for group in disagreements.GroupBy((d Disagreement) -> d.Signature, StringComparer.Ordinal)
                .OrderByDescending((g IGrouping[string, Disagreement]) -> g.Count()) {
                output.WriteLine("== ${group.Key}: ${group.Count()} ==")
                for example in group.Take(limit) {
                    output.WriteLine("  " + example.ToString())
                }
            }
        }
    }
}
