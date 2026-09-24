// <copyright file="ReaderAgreementHarness.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

#nullable enable

using System;
using System.Collections.Generic;
using System.Collections.Immutable;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Text;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Emit;
using GSharp.Core.CodeAnalysis.Symbols;
using Xunit.Abstractions;

namespace GSharp.Core.Tests.ReaderAgreement;

/// <summary>
/// ADR-0193 §4: the reader-agreement differential. For every public member of
/// every generic type (and every public generic method) in a corpus, closes
/// the declaration over a small argument set and computes each signature
/// position through every Layer 1 reader that applies to that closing, then
/// asserts the readers agree on the position's nullability <em>shape</em> —
/// <see cref="TypeSymbol.ReferenceNullability"/> at every position
/// <see cref="TypeSymbol.GetElementPositions"/> enumerates.
/// <para>
/// The readers, and which arguments each can see:
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
/// (<see cref="NullabilityAnnotatedTypeSymbol"/>) over the symbolic projection,
/// carrying the projection reader's flags — the projection at a symbolic closing.</description></item>
/// <item><term><c>symbolic-call</c></term><description><c>MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs</c>
/// (generic-method returns) — the known gap, allowlisted.</description></item>
/// </list>
/// The CLR readers (<c>direct</c>, <c>projection</c>)
/// can only close over a CLR type, which states no reference nullability, so
/// they run only for the erasure-faithful arguments (<c>string</c>,
/// <c>int32</c>, <c>List[string]</c>). <c>string?</c> and an in-scope type
/// parameter reach the symbolic readers only.
/// </para>
/// <para>
/// Every <see cref="NullabilityAnnotatedTypeSymbol"/> any reader returns is
/// also cross-checked: its two lazy accessors
/// (<see cref="NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbol"/> and
/// <see cref="NullabilityAnnotatedTypeSymbol.GetTypeArgumentSymbolForClrType"/>)
/// must agree at every argument they can both address.
/// </para>
/// </summary>
internal sealed class ReaderAgreementHarness
{
    private const BindingFlags PublicMembers = BindingFlags.Public | BindingFlags.Instance
        | BindingFlags.Static | BindingFlags.DeclaredOnly;

    private readonly ReferenceResolver resolver;
    private readonly string corpusName;
    private readonly List<Disagreement> disagreements = new();
    private readonly Dictionary<string, int> readerExceptions = new(StringComparer.Ordinal);
    private readonly ImmutableArray<ArgumentSpec> arguments;

    private int typesVisited;
    private int membersVisited;
    private int positionsCompared;
    private int readerCalls;
    private int closingsSkipped;

    internal ReaderAgreementHarness(ReferenceResolver resolver, string corpusName)
    {
        this.resolver = resolver;
        this.corpusName = corpusName;
        this.arguments = BuildArguments(resolver);
    }

    internal IReadOnlyList<Disagreement> Disagreements => this.disagreements;

    /// <summary>
    /// Gets how many reader calls threw. A throwing reader drops out of the
    /// comparison, which would let a position "agree" with fewer voters, so
    /// the test requires this to be zero.
    /// </summary>
    internal int ReaderExceptionCount => this.readerExceptions.Values.Sum();

    /// <summary>Runs the differential over every public generic declaration in <paramref name="assemblies"/>.</summary>
    /// <param name="assemblies">The corpus.</param>
    /// <returns>The run's summary line.</returns>
    internal string Run(IEnumerable<Assembly> assemblies)
    {
        var stopwatch = Stopwatch.StartNew();
        using (NullabilityOptions.Enter(NullabilityMode.PlatformTypes))
        {
            foreach (var assembly in assemblies)
            {
                foreach (var type in SafeGetExportedTypes(assembly))
                {
                    this.VisitType(type);
                }
            }
        }

        stopwatch.Stop();
        var exceptions = this.readerExceptions.Count == 0
            ? "none"
            : string.Join(", ", this.readerExceptions.OrderBy(p => p.Key, StringComparer.Ordinal).Select(p => $"{p.Key}={p.Value}"));
        return $"{this.corpusName}: {this.typesVisited} types, {this.membersVisited} members, "
            + $"{this.positionsCompared} position closings compared, {this.readerCalls} reader calls, "
            + $"{this.closingsSkipped} closings skipped (constraints), {this.disagreements.Count} disagreements, "
            + $"reader exceptions: {exceptions}; {stopwatch.Elapsed.TotalSeconds:F1}s";
    }

    /// <summary>
    /// Renders a type's nullability shape: the root's
    /// <see cref="TypeSymbol.ReferenceNullability"/> (<c>n</c>, <c>?</c>,
    /// <c>!</c>, or <c>v</c> for not-applicable) followed by its
    /// <see cref="TypeSymbol.GetElementPositions"/>, recursively.
    /// </summary>
    /// <param name="type">The type.</param>
    /// <returns>The shape.</returns>
    internal static string Shape(TypeSymbol type)
    {
        var builder = new StringBuilder();
        Append(type, 0);
        return builder.ToString();

        void Append(TypeSymbol current, int depth)
        {
            builder.Append(current.ReferenceNullability switch
            {
                ReferenceNullabilityKind.NotNull => 'n',
                ReferenceNullabilityKind.Nullable => '?',
                ReferenceNullabilityKind.Platform => '!',
                _ => 'v',
            });

            if (depth > 12)
            {
                builder.Append('…');
                return;
            }

            var positions = current.GetElementPositions();
            if (positions.IsDefaultOrEmpty)
            {
                return;
            }

            builder.Append('<');
            for (var i = 0; i < positions.Length; i++)
            {
                if (i > 0)
                {
                    builder.Append(',');
                }

                Append(positions[i], depth + 1);
            }

            builder.Append('>');
        }
    }

    private static ImmutableArray<ArgumentSpec> BuildArguments(ReferenceResolver resolver)
    {
        var stringType = resolver.GetCoreType("System.String");
        var intType = resolver.GetCoreType("System.Int32");
        var objectType = resolver.GetCoreType("System.Object");
        var builder = ImmutableArray.CreateBuilder<ArgumentSpec>();
        builder.Add(new ArgumentSpec("string", stringType, TypeSymbol.String, ErasureFaithful: true));
        builder.Add(new ArgumentSpec("string?", stringType, NullableTypeSymbol.Get(TypeSymbol.String), ErasureFaithful: false));
        builder.Add(new ArgumentSpec("int32", intType, TypeSymbol.Int32, ErasureFaithful: true));

        if (resolver.TryResolveType("System.Collections.Generic.List`1", out var listDefinition))
        {
            var listOfString = listDefinition.MakeGenericType(stringType);
            builder.Add(new ArgumentSpec(
                "List[string]",
                listOfString,
                ImportedTypeSymbol.GetConstructed(listOfString, listDefinition, ImmutableArray.Create(TypeSymbol.String)),
                ErasureFaithful: true));
        }

        builder.Add(new ArgumentSpec(
            "T",
            objectType,
            new TypeParameterSymbol("T", 0, TypeParameterConstraint.Any, TypeParameterVariance.None),
            ErasureFaithful: false));
        return builder.ToImmutable();
    }

    private static IEnumerable<Type> SafeGetExportedTypes(Assembly assembly)
    {
        Type[] types;
        try
        {
            types = assembly.GetExportedTypes();
        }
        catch (ReflectionTypeLoadException exception)
        {
            types = exception.Types.OfType<Type>().ToArray();
        }
        catch (Exception)
        {
            yield break;
        }

        foreach (var type in types.OrderBy(t => t.FullName, StringComparer.Ordinal))
        {
            yield return type;
        }
    }

    private static bool TryClose(Type definition, ArgumentSpec argument, out Type closed)
    {
        closed = definition;
        if (!SatisfiesConstraints(definition.GetGenericArguments(), argument))
        {
            return false;
        }

        try
        {
            closed = definition.MakeGenericType(
                Enumerable.Repeat(argument.Erased, definition.GetGenericArguments().Length).ToArray());
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (NotSupportedException)
        {
            return false;
        }
        catch (TypeLoadException)
        {
            return false;
        }
    }

    private static bool TryClose(MethodInfo definition, ArgumentSpec argument, out MethodInfo closed)
    {
        closed = definition;
        if (!SatisfiesConstraints(definition.GetGenericArguments(), argument))
        {
            return false;
        }

        try
        {
            closed = definition.MakeGenericMethod(
                Enumerable.Repeat(argument.Erased, definition.GetGenericArguments().Length).ToArray());
            return true;
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (NotSupportedException)
        {
            return false;
        }
        catch (TypeLoadException)
        {
            return false;
        }
    }

    /// <summary>
    /// A <see cref="System.Reflection.MetadataLoadContext"/> does not validate
    /// generic constraints in <c>MakeGenericType</c>, so the harness does. The
    /// in-scope type parameter is unconstrained, so it only closes a slot that
    /// carries no constraint at all.
    /// </summary>
    private static bool SatisfiesConstraints(Type[] parameters, ArgumentSpec argument)
    {
        try
        {
            var candidate = argument.Erased;
            foreach (var parameter in parameters)
            {
                var special = parameter.GenericParameterAttributes & GenericParameterAttributes.SpecialConstraintMask;
                var constraints = parameter.GetGenericParameterConstraints();
                if (argument.Symbolic is TypeParameterSymbol)
                {
                    if (special != GenericParameterAttributes.None || constraints.Length > 0)
                    {
                        return false;
                    }

                    continue;
                }

                if ((special & GenericParameterAttributes.NotNullableValueTypeConstraint) != 0
                    && (!candidate.IsValueType || NullableLifting.IsValueTypeNullableClr(candidate)))
                {
                    return false;
                }

                if ((special & GenericParameterAttributes.ReferenceTypeConstraint) != 0 && candidate.IsValueType)
                {
                    return false;
                }

                if ((special & GenericParameterAttributes.DefaultConstructorConstraint) != 0
                    && !candidate.IsValueType
                    && candidate.GetConstructor(Type.EmptyTypes) == null)
                {
                    return false;
                }

                foreach (var constraint in constraints)
                {
                    if (!Substitute(constraint, candidate).IsAssignableFrom(candidate))
                    {
                        return false;
                    }
                }
            }

            return true;
        }
        catch (Exception exception) when (exception is ArgumentException or NotSupportedException or TypeLoadException or System.IO.FileNotFoundException or InvalidOperationException)
        {
            return false;
        }

        static Type Substitute(Type type, Type argument)
        {
            if (type.IsGenericParameter)
            {
                return argument;
            }

            if (type.IsArray)
            {
                var element = Substitute(Invariant.Required(type.GetElementType(), "an array has an element type"), argument);
                return type.GetArrayRank() == 1 ? element.MakeArrayType() : element.MakeArrayType(type.GetArrayRank());
            }

            if (type.IsGenericType && type.ContainsGenericParameters)
            {
                return type.GetGenericTypeDefinition().MakeGenericType(
                    type.GetGenericArguments().Select(a => Substitute(a, argument)).ToArray());
            }

            return type;
        }
    }

    private static Type StripByRef(Type type)
        => type.IsByRef ? type.GetElementType() ?? type : type;

    private static string Describe(TypeSymbol type)
    {
        try
        {
            return GSharp.Core.CodeAnalysis.Symbols.Display.SymbolDisplay.ToTypeDisplayString(type);
        }
        catch (Exception)
        {
            return type.Name;
        }
    }

    private static string MemberName(MemberInfo member)
        => $"{member.DeclaringType?.FullName ?? "?"}::{member.Name}";

    private static ImmutableArray<byte> Flags(ICustomAttributeProvider provider, MemberInfo enclosing)
        => ClrNullability.ReadNullableFlags(provider, enclosing);

    private void VisitType(Type type)
    {
        if (type.IsGenericTypeDefinition)
        {
            this.typesVisited++;
            foreach (var member in SafeGetMembers(type))
            {
                this.VisitMember(type, member);
            }

            return;
        }

        var visited = false;
        foreach (var method in SafeGetMethods(type))
        {
            if (!method.IsGenericMethodDefinition)
            {
                continue;
            }

            if (!visited)
            {
                this.typesVisited++;
                visited = true;
            }

            this.VisitMember(type, method);
        }
    }

    private static IEnumerable<MemberInfo> SafeGetMembers(Type type)
    {
        MemberInfo[] members;
        try
        {
            members = type.GetMembers(PublicMembers);
        }
        catch (Exception)
        {
            yield break;
        }

        foreach (var member in members)
        {
            if (member is MethodInfo { IsSpecialName: true })
            {
                // Accessors are reached through their property.
                continue;
            }

            if (member is MethodInfo or ConstructorInfo or PropertyInfo or FieldInfo or EventInfo)
            {
                yield return member;
            }
        }
    }

    private static IEnumerable<MethodInfo> SafeGetMethods(Type type)
    {
        MethodInfo[] methods;
        try
        {
            methods = type.GetMethods(PublicMembers);
        }
        catch (Exception)
        {
            yield break;
        }

        foreach (var method in methods)
        {
            yield return method;
        }
    }

    private void VisitMember(Type declaringDefinition, MemberInfo openMember)
    {
        this.membersVisited++;
        foreach (var argument in this.arguments)
        {
            try
            {
                this.VisitClosing(declaringDefinition, openMember, argument);
            }
            catch (Exception exception) when (exception is TypeLoadException or System.IO.FileNotFoundException or NotSupportedException)
            {
                // A member whose signature names a type the corpus cannot
                // resolve cannot be read by ANY reader; it is not a
                // disagreement.
                this.closingsSkipped++;
            }
        }
    }

    private void VisitClosing(Type declaringDefinition, MemberInfo openMember, ArgumentSpec argument)
    {
        var closedType = declaringDefinition;
        var typeArguments = ImmutableArray<TypeSymbol>.Empty;
        if (declaringDefinition.IsGenericTypeDefinition)
        {
            if (!TryClose(declaringDefinition, argument, out closedType))
            {
                this.closingsSkipped++;
                return;
            }

            typeArguments = ImmutableArray.CreateRange(
                Enumerable.Repeat(argument.Symbolic, declaringDefinition.GetGenericArguments().Length));
        }

        var closedMember = FindClosedMember(closedType, openMember);
        if (closedMember == null)
        {
            return;
        }

        var methodArguments = default(ImmutableArray<TypeSymbol?>);
        MethodInfo? openMethod = null;
        if (openMember is MethodInfo { IsGenericMethodDefinition: true } genericOpen)
        {
            var closedDefinition = (MethodInfo)closedMember;
            if (!TryClose(closedDefinition, argument, out var closedMethod))
            {
                this.closingsSkipped++;
                return;
            }

            closedMember = closedMethod;
            openMethod = genericOpen;
            methodArguments = ImmutableArray.CreateRange(
                Enumerable.Repeat<TypeSymbol?>(argument.Symbolic, genericOpen.GetGenericArguments().Length));
        }

        var receiver = declaringDefinition.IsGenericTypeDefinition
            ? ImportedTypeSymbol.GetConstructed(closedType, declaringDefinition, typeArguments)
            : null;

        var context = new ClosingContext(
            declaringDefinition,
            openMember,
            closedMember,
            argument,
            typeArguments,
            openMethod,
            methodArguments,
            receiver);

        switch (openMember)
        {
            case MethodInfo open:
                var closed = (MethodInfo)closedMember;
                if (!IsVoid(open.ReturnType))
                {
                    this.ComparePosition(context, "return", Position.Return(open, closed));
                }

                this.CompareParameters(context, open.GetParameters(), ((MethodBase)closedMember).GetParameters(), open);
                break;
            case ConstructorInfo open:
                this.CompareParameters(context, open.GetParameters(), ((MethodBase)closedMember).GetParameters(), open);
                break;
            case PropertyInfo open:
                this.ComparePosition(context, "property", Position.Property(open, (PropertyInfo)closedMember));
                break;
            case FieldInfo open:
                this.ComparePosition(context, "field", Position.Field(open, (FieldInfo)closedMember));
                break;
            case EventInfo open when open.EventHandlerType != null
                && ((EventInfo)closedMember).EventHandlerType != null:
                this.ComparePosition(context, "event", Position.Event(open, (EventInfo)closedMember));
                break;
        }
    }

    private static bool IsVoid(Type type) => type.FullName == "System.Void";

    private void CompareParameters(
        ClosingContext context,
        ParameterInfo[] openParameters,
        ParameterInfo[] closedParameters,
        MethodBase openMethod)
    {
        for (var i = 0; i < openParameters.Length && i < closedParameters.Length; i++)
        {
            this.ComparePosition(
                context,
                $"parameter {i} ({openParameters[i].Name})",
                Position.Parameter(openParameters[i], closedParameters[i], openMethod, i));
        }
    }

    private static MemberInfo? FindClosedMember(Type closedType, MemberInfo openMember)
    {
        if (ReferenceEquals(closedType, openMember.DeclaringType))
        {
            return openMember;
        }

        try
        {
            foreach (var candidate in closedType.GetMembers(PublicMembers))
            {
                if (candidate.MetadataToken == openMember.MetadataToken
                    && candidate.MemberType == openMember.MemberType)
                {
                    return candidate;
                }
            }
        }
        catch (Exception)
        {
        }

        return null;
    }

    private void ComparePosition(ClosingContext context, string positionName, Position position)
    {
        var shapes = new List<(string Reader, string Shape, string Display)>();
        var openType = StripByRef(position.OpenType);
        var closedType = StripByRef(position.ClosedType);
        var flags = Flags(position.OpenProvider, position.OpenEnclosing);
        var isGenericMethod = context.OpenMethod != null;

        if (context.Argument.ErasureFaithful)
        {
            this.Read(shapes, position, "direct", position.Direct);
            this.Read(shapes, position, "projection", () => ClrNullability.SymbolFromLayoutFlags(closedType, openType, flags));
        }

        this.Read(shapes, position, "merge-symbolic", () => NullableFlagsBuilder.MergeDeclarationNullability(
            this.MapSymbolic(context, openType),
            openType,
            flags));

        if (context.Receiver != null && !isGenericMethod && position.MemberSymbolic != null)
        {
            this.Read(shapes, position, "member-symbolic", () => position.MemberSymbolic(context.Receiver));
        }

        // Not for the in-scope type parameter: the lazy accessor decodes flags
        // against its CLR shape, and a symbolic `T`'s erased shape is
        // `object` — a Reference — so the flags can only say what they would
        // for `object`. gsc never builds that pairing: a symbolic base under
        // a lazy wrapper keeps the CLR generic parameter as its argument
        // (`Binder.RemapImportedMethodTypeParameters`), which the merge reads
        // as an open slot.
        if (closedType.IsConstructedGenericType
            && context.Argument.Symbolic is not TypeParameterSymbol
            && !closedType.IsValueType
            && this.MapSymbolic(context, openType) is ImportedTypeSymbol { TypeArguments.IsDefaultOrEmpty: false } symbolicBase)
        {
            this.Read(shapes, position, "lazy-symbolic", () =>
            {
                var projected = ClrTypeUtilities.AreSame(closedType, openType)
                    ? flags
                    : ClrNullability.ProjectNullableFlags(closedType, openType, flags);
                var annotated = new NullabilityAnnotatedTypeSymbol(symbolicBase, projected);
                return ClrNullability.SymbolForState(annotated, ClrNullability.ClassifyPosition(projected, 0));
            });
        }

        if (isGenericMethod && positionName == "return")
        {
            this.Read(shapes, position, "symbolic-call", () => MemberLookup.ResolveCallReturnTypeFromSymbolicTypeArgs(
                (MethodInfo)context.ClosedMember,
                context.MethodArguments,
                context.Receiver));
        }

        if (shapes.Count == 0)
        {
            return;
        }

        this.positionsCompared++;
        var distinct = shapes.Select(s => s.Shape).Distinct(StringComparer.Ordinal).Count();
        if (distinct > 1)
        {
            this.disagreements.Add(new Disagreement(
                this.corpusName,
                MemberName(context.OpenMember),
                context.OpenMember.ToString() ?? context.OpenMember.Name,
                positionName,
                context.Argument.Name,
                shapes.Select(s => new ReaderResult(s.Reader, s.Shape, s.Display)).ToImmutableArray(),
                openType,
                Tags(openType, position)));
        }
    }

    /// <summary>
    /// Facts about a position that an allowlist entry can match on, so an entry
    /// excuses one known cause rather than one reader everywhere.
    /// <list type="bullet">
    /// <item><description><c>system-tuple</c>: the position mentions the
    /// reference type <c>System.Tuple&lt;…&gt;</c>.</description></item>
    /// <item><description><c>concrete-array-or-tuple</c>: the position contains
    /// an array or <c>ValueTuple</c> that mentions no type parameter.</description></item>
    /// <item><description><c>optional-null-default</c>: a reference parameter
    /// with a <c>null</c> default.</description></item>
    /// </list>
    /// </summary>
    private static ImmutableArray<string> Tags(Type openType, Position position)
    {
        var tags = ImmutableArray.CreateBuilder<string>();
        if (Any(openType, t => t.IsGenericType && GenericDefinitionName(t).StartsWith("System.Tuple`", StringComparison.Ordinal)))
        {
            tags.Add("system-tuple");
        }

        if (Any(openType, t => !t.ContainsGenericParameters
            && (t.IsArray || (t.IsGenericType && GenericDefinitionName(t).StartsWith("System.ValueTuple`", StringComparison.Ordinal)))))
        {
            tags.Add("concrete-array-or-tuple");
        }

        if (position.OptionalNullDefault)
        {
            tags.Add("optional-null-default");
        }

        return tags.ToImmutable();

        static string GenericDefinitionName(Type type)
            => (type.IsGenericTypeDefinition ? type : type.GetGenericTypeDefinition()).FullName ?? string.Empty;

        static bool Any(Type type, Func<Type, bool> match)
        {
            if (match(type))
            {
                return true;
            }

            if (type.HasElementType && type.GetElementType() is { } element)
            {
                return Any(element, match);
            }

            return type.IsGenericType && type.GetGenericArguments().Any(argument => Any(argument, match));
        }
    }

    private TypeSymbol MapSymbolic(ClosingContext context, Type openType)
        => MemberLookup.MapOpenClrTypeToSymbolic(
            openType,
            context.DeclaringDefinition.IsGenericTypeDefinition ? context.DeclaringDefinition : null,
            context.TypeArguments,
            context.OpenMethod,
            context.MethodArguments);

    private void Read(List<(string Reader, string Shape, string Display)> shapes, Position position, string reader, Func<TypeSymbol?> read)
    {
        this.readerCalls++;
        TypeSymbol? result;
        try
        {
            result = read();
        }
        catch (Exception exception) when (exception is not OutOfMemoryException)
        {
            var key = $"{reader}:{exception.GetType().Name}";
            this.readerExceptions[key] = this.readerExceptions.TryGetValue(key, out var count) ? count + 1 : 1;
            return;
        }

        if (result == null)
        {
            return;
        }

        if (position.StripRootNullable && result is NullableTypeSymbol nullableRoot)
        {
            // An event's handler has no nullability of its own to compare:
            // every event reader strips a top-level `?` (the handler delegate
            // field is always nullable), so the comparison does too.
            result = nullableRoot.UnderlyingType;
        }

        shapes.Add((reader, Shape(result), Describe(result)));
        this.CrossCheckLazyAccessors(reader, result);
    }

    /// <summary>
    /// The lazy accessor's two entry points must agree wherever both can
    /// address an argument. Recorded as its own reader pair on the same
    /// position so a disagreement names which accessor drifted.
    /// </summary>
    private void CrossCheckLazyAccessors(string reader, TypeSymbol root)
    {
        var pending = new Stack<(TypeSymbol Type, int Depth)>();
        pending.Push((root, 0));
        while (pending.Count > 0)
        {
            var (current, depth) = pending.Pop();
            if (depth > 8)
            {
                continue;
            }

            if (current is NullabilityAnnotatedTypeSymbol annotated
                && annotated.ClrType is { IsGenericType: true, IsGenericTypeDefinition: false } clr)
            {
                var clrArguments = clr.GetGenericArguments();
                for (var i = 0; i < clrArguments.Length; i++)
                {
                    if (clrArguments.Count(a => ClrTypeUtilities.AreSame(a, clrArguments[i])) != 1)
                    {
                        continue;
                    }

                    var byIndex = Shape(annotated.GetTypeArgumentSymbol(i));
                    var byClrType = Shape(annotated.GetTypeArgumentSymbolForClrType(clrArguments[i]));
                    if (!string.Equals(byIndex, byClrType, StringComparison.Ordinal))
                    {
                        this.disagreements.Add(new Disagreement(
                            this.corpusName,
                            $"{reader} lazy accessors",
                            Describe(annotated),
                            $"type argument {i}",
                            string.Empty,
                            ImmutableArray.Create(
                                new ReaderResult("lazy-index", byIndex, string.Empty),
                                new ReaderResult("lazy-clrtype", byClrType, string.Empty)),
                            clr,
                            ImmutableArray<string>.Empty));
                    }
                }
            }

            foreach (var position in SafePositions(current))
            {
                pending.Push((position, depth + 1));
            }
        }
    }

    private static ImmutableArray<TypeSymbol> SafePositions(TypeSymbol type)
    {
        try
        {
            return type.GetElementPositions();
        }
        catch (Exception)
        {
            return ImmutableArray<TypeSymbol>.Empty;
        }
    }

    /// <summary>Writes up to <paramref name="limit"/> disagreements, grouped by the readers that dissent.</summary>
    /// <param name="output">The test output.</param>
    /// <param name="disagreements">The disagreements to report.</param>
    /// <param name="limit">The maximum number of examples per group.</param>
    internal static void Report(ITestOutputHelper output, IEnumerable<Disagreement> disagreements, int limit = 5)
    {
        foreach (var group in disagreements
            .GroupBy(d => d.Signature, StringComparer.Ordinal)
            .OrderByDescending(g => g.Count()))
        {
            output.WriteLine($"== {group.Key}: {group.Count()} ==");
            foreach (var example in group.Take(limit))
            {
                output.WriteLine("  " + example);
            }
        }
    }

    internal sealed record ArgumentSpec(string Name, Type Erased, TypeSymbol Symbolic, bool ErasureFaithful);

    internal sealed record ReaderResult(string Reader, string Shape, string Display);

    /// <summary>One position where the readers produced more than one shape.</summary>
    /// <param name="Corpus">The corpus name.</param>
    /// <param name="Member">The declaring type and member name.</param>
    /// <param name="MemberSignature">The member's reflected signature.</param>
    /// <param name="PositionName">Which signature position.</param>
    /// <param name="Argument">Which closing argument.</param>
    /// <param name="Results">Each reader's shape.</param>
    /// <param name="OpenPositionType">The open declaration's type at the position.</param>
    /// <param name="Tags">Facts about the position an allowlist entry can match (<see cref="Tags(Type, Position)"/>).</param>
    internal sealed record Disagreement(
        string Corpus,
        string Member,
        string MemberSignature,
        string PositionName,
        string Argument,
        ImmutableArray<ReaderResult> Results,
        Type OpenPositionType,
        ImmutableArray<string> Tags)
    {
        /// <summary>
        /// Gets the readers in the minority — the ones whose shape differs from
        /// the most common shape. For a tie, every reader not in the first
        /// group. This is what an allowlist entry matches.
        /// </summary>
        internal ImmutableArray<string> Dissenters
        {
            get
            {
                var majority = this.Results
                    .GroupBy(r => r.Shape, StringComparer.Ordinal)
                    .OrderByDescending(g => g.Count())
                    .ThenBy(g => g.Min(r => r.Reader), StringComparer.Ordinal)
                    .First()
                    .Key;
                return this.Results
                    .Where(r => !string.Equals(r.Shape, majority, StringComparison.Ordinal))
                    .Select(r => r.Reader)
                    .OrderBy(r => r, StringComparer.Ordinal)
                    .ToImmutableArray();
            }
        }

        /// <summary>Gets a grouping key: the dissenting readers and the argument.</summary>
        internal string Signature => $"dissent[{string.Join("+", this.Dissenters)}] arg={this.Argument} pos={(this.PositionName.StartsWith("parameter", StringComparison.Ordinal) ? "parameter" : this.PositionName)}";

        /// <inheritdoc/>
        public override string ToString()
            => $"{this.Corpus} {this.Member} [{this.MemberSignature}] {this.PositionName} @ {this.Argument}: "
                + string.Join("; ", this.Results.Select(r => $"{r.Reader}={r.Shape} ({r.Display})"));
    }

    private sealed record ClosingContext(
        Type DeclaringDefinition,
        MemberInfo OpenMember,
        MemberInfo ClosedMember,
        ArgumentSpec Argument,
        ImmutableArray<TypeSymbol> TypeArguments,
        MethodInfo? OpenMethod,
        ImmutableArray<TypeSymbol?> MethodArguments,
        ImportedTypeSymbol? Receiver);

    /// <summary>One signature position, with the readers that are specific to its member kind.</summary>
    private sealed record Position(
        Type OpenType,
        Type ClosedType,
        ICustomAttributeProvider OpenProvider,
        MemberInfo OpenEnclosing,
        Func<TypeSymbol> Direct,
        Func<TypeSymbol, TypeSymbol>? MemberSymbolic,
        bool OptionalNullDefault = false,
        bool StripRootNullable = false)
    {
        internal static Position Return(MethodInfo open, MethodInfo closed)
            => new(
                open.ReturnType,
                closed.ReturnType,
                open.ReturnParameter,
                open,
                () => ClrNullability.GetReturnTypeSymbol(closed),
                receiver => MemberLookup.GetClrMethodReturnTypeSymbol(receiver, closed));

        internal static Position Parameter(ParameterInfo open, ParameterInfo closed, MethodBase openMethod, int index)
            => new(
                open.ParameterType,
                closed.ParameterType,
                open,
                openMethod,
                () => ClrNullability.GetParameterTypeSymbol(closed),
                closed.Member is MethodInfo closedMethod
                    ? receiver => MemberLookup.GetClrMethodParameterTypeSymbol(receiver, closedMethod, index)
                    : null,
                HasOptionalNullDefault(closed));

        /// <summary>
        /// The condition under which <c>ClrNullability.GetParameterTypeSymbol</c>
        /// lifts a reference parameter to <c>T?</c> for its <c>null</c> default.
        /// </summary>
        private static bool HasOptionalNullDefault(ParameterInfo parameter)
        {
            try
            {
                var type = parameter.ParameterType.IsByRef ? parameter.ParameterType.GetElementType() : parameter.ParameterType;
                if (type?.IsValueType != false || !(parameter.HasDefaultValue || parameter.IsOptional))
                {
                    return false;
                }

                var value = parameter.RawDefaultValue;
                return value == null || ReferenceEquals(value, Missing.Value) || ReferenceEquals(value, DBNull.Value);
            }
            catch (Exception exception) when (exception is FormatException or InvalidOperationException or NotSupportedException)
            {
                return false;
            }
        }

        internal static Position Property(PropertyInfo open, PropertyInfo closed)
            => new(
                open.PropertyType,
                closed.PropertyType,
                open,
                Invariant.Required(open.DeclaringType, "a property has a declaring type"),
                () => ClrNullability.GetPropertyTypeSymbol(closed),
                receiver => MemberLookup.GetClrPropertyTypeSymbol(receiver, closed));

        internal static Position Event(EventInfo open, EventInfo closed)
            => new(
                Invariant.Required(open.EventHandlerType, "the caller checked the handler type"),
                Invariant.Required(closed.EventHandlerType, "the caller checked the handler type"),
                open,
                Invariant.Required(open.DeclaringType, "an event has a declaring type"),
                () => MemberLookup.GetClrEventHandlerTypeSymbol(closed),
                receiver => MemberLookup.GetClrEventHandlerTypeSymbol(receiver, closed),
                StripRootNullable: true);

        internal static Position Field(FieldInfo open, FieldInfo closed)
            => new(
                open.FieldType,
                closed.FieldType,
                open,
                Invariant.Required(open.DeclaringType, "a field has a declaring type"),
                () => ClrNullability.GetFieldTypeSymbol(closed),
                receiver => MemberLookup.GetClrFieldTypeSymbol(receiver, closed));
    }
}
