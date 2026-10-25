// <copyright file="ExpressionBinder.Access.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Diagnostics.CodeAnalysis
import System.Linq
import System.Reflection
import System.Text
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis

internal partial class ExpressionBinder {
    /// Issue #503 follow-up: rotates a right-associative member-access chain
    /// into the canonical left-associative form so the rightmost identifier is
    /// the immediate (cref:AccessorExpressionSyntax.RightPart). The
    /// parser produces `A . (B . C)` for `A.B.C`; this helper
    /// rewrites it as `(A . B) . C` so the event-subscription binder can
    /// treat the LHS uniformly (receiver expression on the left, event name on
    /// the right) regardless of how many segments the receiver chain has.
    private func NormalizeAccessorLeftAssociative(accessor AccessorExpressionSyntax) AccessorExpressionSyntax {
        var accessor = accessor
        while accessor.RightPart is AccessorExpressionSyntax rightChain {
            let newLeft = AccessorExpressionSyntax(
                accessor.SyntaxTree,
                accessor.LeftPart,
                accessor.DotToken,
                rightChain.LeftPart
            )
            accessor = AccessorExpressionSyntax(accessor.SyntaxTree, newLeft, rightChain.DotToken, rightChain.RightPart)
        }
        return accessor
    }

    private func BuildInstanceMethodGroup(
        receiver BoundExpression?,
        methods ImmutableArray[FunctionSymbol],
        forceNonVirtualDispatch bool = false
    ) BoundMethodGroupExpression {
        if methods.Length == 1 && !methods[0].IsGeneric {
            let only = methods[0]
            // Issue #3248: the candidate comes from the receiver type's
            // DEFINITION (a constructed StructSymbol forwards `Methods` to
            // it), so its parameter/return types still reference the
            // declaring class's own type parameters. Substitute the
            // signature through the receiver's construction of the declaring
            // definition (resolved along the base chain) so the group's
            // FunctionType carries the receiver's instantiation. Without
            // this, a deferred method group like `holder.Count` inside
            // `GetCounter[T](holder Holder[T])` kept `Holder`'s class type
            // parameter in its function type and the emitter encoded the
            // delegate TypeSpec with a class `Var` slot in a context that
            // only has method generics (invalid metadata;
            // BadImageFormatException at runtime).
            let owner = if receiver?.Type is StructSymbol receiverStruct &&
                only.ReceiverType is StructSymbol declaredReceiver {
                TypeMemberModel.ResolveStaticMemberOwner(receiverStruct, declaredReceiver)
            } else {
                default(StructSymbol?)
            }
            let paramTypes = ImmutableArray.CreateBuilder[TypeSymbol](only.Parameters.Length)
            for p in only.Parameters {
                paramTypes.Add(owner?.SubstituteMemberType(p.Type) ?? p.Type)
            }
            var returnType = this.MethodGroupObservableReturnType(only)
            returnType = owner?.SubstituteMemberType(returnType) ?? returnType
            let fnType = FunctionTypeSymbol.Get(paramTypes.MoveToImmutable(), returnType)
            return BoundMethodGroupExpression(nil, receiver, only, fnType){
                ForceNonVirtualDispatch = forceNonVirtualDispatch
            }
        }
        return BoundMethodGroupExpression(nil, receiver, methods){ForceNonVirtualDispatch = forceNonVirtualDispatch}
    }

    // Issue #1467: a method group's natural delegate return type must match the
    // method's *observable* (emitted) return type. An async method symbol carries
    // a Void result for "async no-result" but the emitted state machine returns
    // Task, so the method-group natural delegate is Func&lt;Task&gt; (not Action).
    // Async iterators keep their IAsyncEnumerable return unchanged.
    private func MethodGroupObservableReturnType(function FunctionSymbol) TypeSymbol {
        let declared = function.Type ?? TypeSymbol.Void
        if function.IsAsyncOrSuspending && !function.IsAsyncVoid && !isAsyncIteratorReturnType(declared) {
            return lambdas.WrapAsTask(declared, function.AsyncReturnsValueTask)
        }
        return declared
    }

    /// ADR-0112 §"method-group semantics": builds a (cref:BoundMethodGroupExpression)
    /// for a user-defined type's method(s). A [`receiver`](paramref) of
    /// `null` yields a static (null-target) group; a non-null
    /// receiver yields an instance group captured against it. Variadic
    /// candidates are filtered out; the group is only produced when at least one
    /// usable candidate remains.
    private func TryBuildUserMethodGroup(
        receiver BoundExpression?,
        methods ImmutableArray[FunctionSymbol],
        @NotNullWhen(true) out methodGroup BoundExpression?,
        staticOwnerType StructSymbol? = nil
    ) bool {
        methodGroup = nil
        if methods.IsDefaultOrEmpty {
            return false
        }
        let usable = ImmutableArray.CreateBuilder[FunctionSymbol](methods.Length)
        for m in methods {
            var hasVariadic = false
            for parameter in m.Parameters {
                if parameter.IsVariadic {
                    hasVariadic = true
                    break
                }
            }
            if hasVariadic {
                continue
            }
            usable.Add(m)
        }
        if usable.Count == 0 {
            return false
        }
        let usableMethods = usable.ToImmutable()
        methodGroup = if staticOwnerType == nil {
            BuildInstanceMethodGroup(receiver, usableMethods)
        } else {
            BoundMethodGroupExpression(nil, receiver, usableMethods, staticOwnerType)
        }
        return true
    }

    /// Binds a fully-qualified imported-type constructor written in expression
    /// position, e.g. `System.Text.StringBuilder()` or
    /// `System.Collections.Generic.List[int]()`, including an object
    /// initializer suffix. Such an expression parses as an accessor chain whose
    /// constructor call is either terminal or followed by an instance-member
    /// suffix, so it never reaches (cref:TryBindClrConstructorCall) (which
    /// only sees simple-name calls). This walks the dotted name, resolves the
    /// closed CLR type via the active references/imports, and reuses the shared
    /// constructor-binding core (issues #293 and #4055).
    /// @param syntax The accessor expression to bind.
    /// @param result The bound constructor call on success.
    /// @returns Whether the accessor was a fully-qualified constructor call that bound successfully.
    private func TryBindQualifiedClrConstructorCall(
        syntax AccessorExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if syntax.IsNullConditional || QualifiedAccessStartsWithValue(syntax) {
            return false
        }
        // Flatten the accessor chain into the leading namespace/type segments
        // and the terminal constructor call. Anything that isn't a pure
        // dotted-name chain ending in a call (optionally wrapped by an object
        // initializer) is not a qualified constructor.
        let segments = List[string]()
        var current ExpressionSyntax = syntax
        var terminalCall CallExpressionSyntax? = nil
        var terminalObjectCreation ObjectCreationExpressionSyntax? = nil
        var terminalCollectionInitializer CollectionInitializerExpressionSyntax? = nil
        var trailingAccess ExpressionSyntax? = nil
        while true {
            if current is AccessorExpressionSyntax accessor {
                if accessor.IsNullConditional {
                    return false
                }
                if accessor.LeftPart is NameExpressionSyntax leftName {
                    segments.Add(leftName.IdentifierToken.ValueText)
                    current = accessor.RightPart
                    continue
                }
                if accessor.LeftPart is CallExpressionSyntax nestedCall {
                    // `System.Nullable[int32]().HasValue` keeps the call on the
                    // left of the final accessor; bind it here, then continue on
                    // the constructed value rather than re-reading `System` as a type.
                    terminalCall = nestedCall
                    trailingAccess = accessor.RightPart
                    break
                }
                if accessor.LeftPart is ObjectCreationExpressionSyntax{
                    Target: CallExpressionSyntax nestedObjectCall
                } nestedObjectCreation {
                    terminalCall = nestedObjectCall
                    terminalObjectCreation = nestedObjectCreation
                    trailingAccess = accessor.RightPart
                    break
                }
                if accessor.LeftPart is CollectionInitializerExpressionSyntax{
                    Target: CallExpressionSyntax nestedCollectionCall
                } nestedCollection {
                    terminalCall = nestedCollectionCall
                    terminalCollectionInitializer = nestedCollection
                    trailingAccess = accessor.RightPart
                    break
                }
                return false
            }
            if current is CallExpressionSyntax call {
                terminalCall = call
                break
            }
            if current is ObjectCreationExpressionSyntax{Target: CallExpressionSyntax objectCall} objectCreation {
                terminalCall = objectCall
                terminalObjectCreation = objectCreation
                break
            }
            if current is CollectionInitializerExpressionSyntax{
                Target: CallExpressionSyntax collectionCall
            } collectionInitializer {
                terminalCall = collectionCall
                terminalCollectionInitializer = collectionInitializer
                break
            }
            // A bare trailing name (`System.Text.StringBuilder` with no call)
            // is not a constructor invocation.
            return false
        }
        if terminalCall == nil || terminalCall.Identifier.IsMissing {
            return false
        }
        let typeSimpleName = terminalCall.Identifier.ValueText
        let namespacePrefix = string.Join(".", segments)
        if !TryResolveQualifiedClrType(
            namespacePrefix,
            typeSimpleName,
            terminalCall.TypeArgumentList,
            out var clrType,
            out var openGenericDef,
            out var symbolicArgs
        ) {
            return false
        }
        // Issue #3749: the sibling omission is the final argument below. Every
        // other caller of `FinishClrConstructorBindingFailure` supplies the
        // conversion target, which is what lets a one-argument `T(x)` that
        // matched no constructor fall back to the ADR-0047 §6 conversion-call
        // reading. This caller — the DOTTED form, and therefore the only route
        // a NESTED type can take — passed none, so
        // `DebuggableAttribute.DebuggingModes(2)` had no conversion arm to land
        // on and reported GS0159 instead.
        var handled = TryBindClrConstructorFromType(
            clrType!!,
            terminalCall,
            out result,
            out var noApplicableOverload,
            out var boundArguments,
            openGenericDef,
            symbolicArgs
        ) ||
            FinishClrConstructorBindingFailure(
            terminalCall,
            typeSimpleName,
            noApplicableOverload,
            boundArguments,
            &result,
            TypeSymbol.FromClrTypeWithoutNullability(clrType, NullabilityFreeReason.TypeStructure)
        )
        // Issue #3821: the shared failure helper only commits to the
        // no-applicable-overload diagnostic when the call carries an explicit
        // type-argument list (issue #2633 fixed this cascade for the GENERIC
        // spelling only). Without that, a non-generic qualified construction
        // whose arguments match no constructor answered "not handled", the
        // whole accessor chain re-bound as a namespace walk, and the walk
        // failed at its HEAD — reporting GS0157 "Cannot find type System"
        // about a segment that resolves perfectly. cs2gs writes fully-qualified
        // type names whenever a simple name is ambiguous (issues #2258/#3805),
        // so on the self-migration corpus every argument error at such a call
        // site collapsed into that one misleading line.
        //
        // Committing is gated twice, because two later arms of
        // `BindAccessorExpression` can still bind a chain this one gave up on:
        //
        //   * the prefix must be a NAMESPACE, not a type. When the last prefix
        //     segment is itself a type (`Outer.Nested(...)`,
        //     `DebuggableAttribute.DebuggingModes(2)`), the fully-qualified
        //     static-access arm can still find a member of it.
        //   * the terminal simple name must not also name a SOURCE type. A
        //     package-qualified source construction (`Oahu.Tui.Nested.Refresh(1)`,
        //     issue #2585) reaches the CLR arm first and can resolve a
        //     same-named REFERENCE type whose constructors do not match — the
        //     source arm below is the one that binds it.
        //
        // A namespace prefix with no source homonym has neither second chance,
        // so there the fallthrough can only ever produce GS0157.
        if !handled && noApplicableOverload && namespacePrefix.Length > 0 && !$scope.References!!.TryResolveType(
            namespacePrefix,
            out _
        ) &&
            !TryLookupSourceTypeWithImportPrecedence(typeSimpleName, preferredArity: -1, declaration: nil, out _) {
            Diagnostics.ReportNoApplicableOverload(terminalCall.Identifier.Location, typeSimpleName)
            result = BoundErrorExpression(terminalCall)
            handled = true
        }
        if handled && terminalObjectCreation != nil {
            result = BindObjectInitializerSuffix(
                terminalObjectCreation,
                Invariant.Required(
                    result,
                    "a successful qualified constructor binding produces a bound target",
                    expression: "result"
                )
            )
        }
        if handled && terminalCollectionInitializer != nil {
            result = BindCollectionInitializerSuffix(
                terminalCollectionInitializer,
                Invariant.Required(
                    result,
                    "a qualified constructor produces an initializer receiver",
                    expression: "result"
                )
            )
        }
        if handled && trailingAccess != nil && !(result is BoundErrorExpression) {
            result = BindAccessorStep(
                Invariant.Required(
                    result,
                    "a successful qualified constructor binding produces a bound target",
                    expression: "result"
                ),
                classSymbol: nil,
                trailingAccess
            )
        }
        return handled
    }

    /// Issue #2258: binds a fully-qualified imported-type object-initializer
    /// literal written in expression position, e.g.
    /// `System.Text.Json.JsonWriterOptions{ Indented: true }`. Such an
    /// expression parses as an accessor chain whose terminal segment is the
    /// struct literal ((cref:StructLiteralExpressionSyntax)), so it never
    /// reaches the simple-name literal path in
    /// (cref:BindStructLiteralExpression(StructLiteralExpressionSyntax)).
    /// This walks the dotted name the same way (cref:TryBindQualifiedClrConstructorCall)
    /// does, resolves the closed CLR type via the active references/imports, and
    /// binds the literal against it — generalizing to any referenced CLR type
    /// (class or struct) at any namespace depth.
    /// @param syntax The accessor expression to bind.
    /// @param result The bound struct-literal expression on success.
    /// @returns Whether the accessor was a fully-qualified struct literal that bound successfully.
    private func TryBindQualifiedClrStructLiteral(
        syntax AccessorExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if syntax.IsNullConditional || QualifiedAccessStartsWithValue(syntax) {
            return false
        }
        // Flatten the accessor chain into the leading namespace/type segments
        // and the terminal struct literal. Anything that isn't a pure
        // dotted-name chain ending in a struct literal is not a qualified
        // literal.
        let segments = List[string]()
        var current ExpressionSyntax = syntax
        var terminalLiteral StructLiteralExpressionSyntax? = nil
        while true {
            if current is AccessorExpressionSyntax accessor {
                if accessor.IsNullConditional || !(accessor.LeftPart is NameExpressionSyntax leftName) {
                    return false
                }
                segments.Add(leftName.IdentifierToken.ValueText)
                current = accessor.RightPart
                continue
            }
            if current is StructLiteralExpressionSyntax literal {
                terminalLiteral = literal
                break
            }
            // A bare trailing name/call is not a struct literal.
            return false
        }
        if terminalLiteral == nil || terminalLiteral.TypeIdentifier.IsMissing {
            return false
        }
        let typeSimpleName = terminalLiteral.TypeIdentifier.ValueText
        let namespacePrefix = string.Join(".", segments)
        if !TryResolveQualifiedClrType(
            namespacePrefix,
            typeSimpleName,
            terminalLiteral.TypeArgumentList,
            out var clrType,
            out _,
            out _
        ) {
            return false
        }
        result = BindImportedTypeLiteralExpression(terminalLiteral, clrType!!)
        return true
    }

    private func QualifiedAccessStartsWithValue(
        syntax AccessorExpressionSyntax
    ) bool -> syntax.LeftPart is NameExpressionSyntax name &&
        $scope.TryLookupSymbol(name.IdentifierToken.ValueText) is VariableSymbol

    /// Binds a same-compilation SOURCE type constructed or referenced through a
    /// package-qualified name — e.g. `Oahu.Decrypt.Mp4Operation(...)` or the
    /// generic `Oahu.Decrypt.Mp4Operation[TResult](...)`. cs2gs
    /// fully-qualifies type references, but source types have no CLR type while
    /// binding. Resolve the complete source identity before binding its construction
    /// or static members. Constructor arguments retain their ordinary lexical scope.
    /// @param syntax The accessor chain forming the qualified name.
    /// @param result The bound terminal construction on success.
    /// @returns Whether the qualified name bound to a source-type construction.
    private func TryBindQualifiedSourceTypeConstruction(
        syntax AccessorExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        if !TryResolveQualifiedSourceType(syntax, out var remainder, out var sourceType) {
            return false
        }
        result = BindQualifiedSourceTypeRemainder(remainder, sourceType!!)
        return true
    }

    private func TryResolveQualifiedSourceType(
        syntax AccessorExpressionSyntax,
        out remainder ExpressionSyntax,
        @NotNullWhen(true) out sourceType TypeSymbol?
    ) bool {
        remainder = syntax
        sourceType = nil
        if syntax.IsNullConditional {
            return false
        }
        // Peel namespace segments until a value or type receiver begins.
        // Namespace import aliases expand during exact source lookup. Only the FIRST segment is
        // required to fail the in-scope-value check: once a segment has been
        // accepted as a namespace-prefix component, the chain can no longer be a
        // value-access chain (there is no value at its head to access `.member`
        // on), so a later segment coincidentally sharing a name with an unrelated
        // in-scope value (e.g. a field on the enclosing type) is not a genuine
        // alternate interpretation and must not stop peeling (issue #2419).
        var current ExpressionSyntax = syntax
        while current is AccessorExpressionSyntax step &&
            !step.IsNullConditional &&
            step.LeftPart is AccessorExpressionSyntax left &&
            !left
            .IsNullConditional {
            let right = AccessorExpressionSyntax(step.SyntaxTree, left.RightPart, step.DotToken, step.RightPart)
            current = AccessorExpressionSyntax(step.SyntaxTree, left.LeftPart, left.DotToken, right)
        }
        var peeledAny = false
        let peeledSegments = List[string]()
        while current is AccessorExpressionSyntax accessor &&
            !accessor.IsNullConditional &&
            accessor.LeftPart is NameExpressionSyntax leftName {
            let segment = leftName.IdentifierToken.ValueText
            if IsQualifiedSourceTypeBoundary(peeledSegments, segment) ||
                !IsNamespacePrefixSegment(segment, isLeadingSegment: !peeledAny) {
                break
            }
            peeledSegments.Add(segment)
            current = accessor.RightPart
            peeledAny = true
        }
        // Only fire when at least one namespace segment was peeled (so ordinary
        // static-member access and simple-name construction are untouched) and
        // the remainder's head names a same-compilation user aggregate source
        // type — a constructor call `Type(...)`, a struct literal `Type{...}`, or
        // a static-member access `Type.Member` / `Type[Args].Member`.
        if !peeledAny {
            return false
        }
        remainder = current
        return TryResolveQualifiedSourceTypeHead(current, peeledSegments, out sourceType)
    }

    /// Resolves the qualified source identity of a construction or static receiver.
    /// @param remainder The expression after its namespace prefix.
    /// @param packageSegments The namespace prefix segments.
    /// @param sourceType The resolved aggregate type.
    /// @returns Whether the complete source name resolves.
    private func TryResolveQualifiedSourceTypeHead(
        remainder ExpressionSyntax,
        packageSegments List[string],
        @NotNullWhen(true) out sourceType TypeSymbol?
    ) bool {
        sourceType = nil
        var simpleName string
        var arity int32
        switch remainder {
            case CollectionInitializerExpressionSyntax{Target: {} target} {
                return TryResolveQualifiedSourceTypeHead(target, packageSegments, out sourceType)
            }
            case ObjectCreationExpressionSyntax{Target: {} target} {
                return TryResolveQualifiedSourceTypeHead(target, packageSegments, out sourceType)
            }
            case accessor is AccessorExpressionSyntax {
                return TryResolveQualifiedSourceTypeHead(accessor.LeftPart, packageSegments, out sourceType)
            }
            case call is CallExpressionSyntax when !call.Identifier.IsMissing {
                simpleName = call.Identifier.ValueText
                arity = call.TypeArgumentList?.Arguments.Count ?? -1
            }
            case literal is StructLiteralExpressionSyntax when !literal.TypeIdentifier.IsMissing {
                simpleName = literal.TypeIdentifier.ValueText
                arity = literal.TypeArgumentList?.Arguments.Count ?? -1
            }
            case genericHead is GenericNameExpressionSyntax {
                simpleName = genericHead.Identifier.ValueText
                arity = genericHead.TypeArgumentList?.Arguments.Count ?? 0
            }
            case nameHead is NameExpressionSyntax {
                simpleName = nameHead.IdentifierToken.ValueText
                arity = 0
            }
            case index is IndexExpressionSyntax when index.Target is NameExpressionSyntax indexNameHead {
                simpleName = indexNameHead.IdentifierToken.ValueText
                arity = index.Indices.Count
            }
            default {
                return false
            }
        }
        let segments = packageSegments.Append(simpleName).ToArray()
        return $scope.TryLookupQualifiedSourceType(
            $scope.ExpandQualifiedTypeName(segments, segments.Length),
            arity,
            out sourceType
        ) &&
            IsUserAggregateType(sourceType!!)
    }

    private func BindQualifiedSourceTypeRemainder(remainder ExpressionSyntax, sourceType TypeSymbol) BoundExpression {
        switch remainder {
            case call is CallExpressionSyntax {
                return overloads.BindCallExpression(call, sourceType)
            }
            case literal is StructLiteralExpressionSyntax when sourceType is StructSymbol structure {
                return BindStructLiteralExpression(literal, structure)
            }
            case ObjectCreationExpressionSyntax{Target: {} target} creation {
                return BindObjectInitializerSuffix(creation, BindQualifiedSourceTypeRemainder(target, sourceType))
            }
            case CollectionInitializerExpressionSyntax{Target: {} target} collection {
                return BindCollectionInitializerSuffix(collection, BindQualifiedSourceTypeRemainder(target, sourceType))
            }
            case accessor is AccessorExpressionSyntax {
                if accessor.LeftPart is CallExpressionSyntax or
                    StructLiteralExpressionSyntax or
                    ObjectCreationExpressionSyntax or
                    CollectionInitializerExpressionSyntax {
                    let receiver = BindQualifiedSourceTypeRemainder(accessor.LeftPart, sourceType)
                    if receiver is BoundErrorExpression {
                        return receiver
                    }
                    return if accessor.IsNullConditional {
                        BindNullConditionalAccessExpressionCore(receiver, accessor.RightPart)
                    } else {
                        BindAccessorStep(receiver, classSymbol: nil, accessor.RightPart)
                    }
                }
                var structure StructSymbol? = sourceType as StructSymbol
                var interface_ InterfaceSymbol? = sourceType as InterfaceSymbol
                if accessor.LeftPart is IndexExpressionSyntax or GenericNameExpressionSyntax {
                    if !TryResolveConstructedGenericTypeReceiver(
                        accessor.LeftPart,
                        out structure,
                        out interface_,
                        out _,
                        out _,
                        sourceType
                    ) {
                        return BoundErrorExpression(remainder)
                    }
                }
                if sourceType is EnumSymbol enumeration {
                    return BindEnumAccessorStep(enumeration, accessor.RightPart)
                }
                return BindConstructedGenericTypeAccessorStep(
                    structure,
                    interface_,
                    constructedImported: nil,
                    accessor.RightPart,
                    accessor.LeftPart
                )
            }
        }
        Diagnostics.ReportUnableToFindType(remainder.Location, sourceType.Name)
        return BoundErrorExpression(remainder)
    }

    /// Resolves a closed CLR type from a fully-qualified dotted name written in
    /// source. Tries the name as written, the name with the leading segment
    /// expanded from a matching import alias/path, and the name prefixed by each
    /// active import target. Generic type arguments on [`typeArgumentList`](paramref)
    /// are honoured by resolving the mangled open generic and closing it.
    /// @param namespacePrefix The dotted segments preceding the type name (may be empty).
    /// @param typeSimpleName The simple type name (the constructor call / struct literal identifier).
    /// @param typeArgumentList The terminal's explicit type-argument list (from a constructor call or a
    /// struct literal), used for generic arity/arguments; `null`
    /// for a non-generic reference.
    /// @param clrType The resolved closed CLR type on success.
    /// @param openGenericDefinition Issue #671: when one or more type arguments are G# user-defined types
    /// (no CLR type at bind time), the closed CLR shape is type-erased to
    /// (cref:object) placeholders and this is set to the open generic
    /// definition so the emitter can recover the symbolic form.
    /// `null` otherwise.
    /// @param symbolicTypeArgs Issue #671: the original symbolic type arguments in source order when
    /// any user-defined type substitution is in effect; default otherwise.
    /// @returns Whether a type was resolved.
    private func TryResolveQualifiedClrType(
        namespacePrefix string,
        typeSimpleName string,
        typeArgumentList TypeArgumentListSyntax?,
        @NotNullWhen(true) out clrType Type?,
        out openGenericDefinition Type?,
        out symbolicTypeArgs ImmutableArray[TypeSymbol]
    ) bool {
        clrType = nil
        openGenericDefinition = nil
        symbolicTypeArgs = default(ImmutableArray[TypeSymbol])
        let arity = typeArgumentList?.Arguments.Count ?? 0
        // Build the candidate dotted prefixes (everything before the simple
        // type name), most specific first.
        let prefixCandidates = List[string]()
        let seenPrefixes = HashSet[string](StringComparer.Ordinal)
        if !string.IsNullOrEmpty(namespacePrefix) {
            prefixCandidates.Add(namespacePrefix)
        }
        // If the leading segment is an import alias/path, expand it to the
        // import target (`import t = System.Text` then `t.StringBuilder()`).
        let firstSegment = if namespacePrefix.Contains('.', StringComparison.Ordinal) {
            namespacePrefix.Substring(0, namespacePrefix.IndexOf('.', StringComparison.Ordinal))
        } else {
            namespacePrefix
        }
        if !string.IsNullOrEmpty(firstSegment) && $scope.TryLookupImport(firstSegment, out var matchedImport) {
            let rest = if namespacePrefix.Length > firstSegment.Length {
                namespacePrefix.Substring(firstSegment.Length + 1)
            } else {
                string.Empty
            }
            let expanded = if string.IsNullOrEmpty(rest) {
                matchedImport!!.Target
            } else {
                matchedImport!!.Target + "." + rest
            }
            prefixCandidates.Insert(0, expanded)
        }
        // Also try the name relative to each active import target, mirroring the
        // simple-name lookup in BoundScope.TryLookupImportedClass.
        for import_ in $scope.GetDeclaredImports() {
            let prefixed = if string.IsNullOrEmpty(namespacePrefix) {
                import_.Target
            } else {
                import_.Target + "." + namespacePrefix
            }
            prefixCandidates.Add(prefixed)
        }
        for prefix in prefixCandidates {
            // Issue #854: the candidate list frequently contains duplicate
            // prefixes (e.g. the raw namespacePrefix also surfaces as an
            // import-relative candidate). Resolution is deterministic per name,
            // so probing the same prefix twice can never change the outcome —
            // skip repeats to avoid redundant resolver lookups and, in the
            // generic branch, redundant type-argument binding.
            if !seenPrefixes.Add(prefix) {
                continue
            }
            if arity > 0 {
                if typeArgumentList == nil {
                    return false
                }
                let mangled = prefix + "." + typeSimpleName + "`" + arity.ToString()
                if $scope.References!!.TryResolveType(mangled, out var openType) {
                    let clrArgs = [arity]Type
                    let symbolic = ImmutableArray.CreateBuilder[TypeSymbol](arity)
                    var argsResolved = true
                    var hasSymbolicArg = false
                    for var i = 0; i < arity; i++ {
                        let ta TypeSymbol? = bindTypeClause(typeArgumentList.Arguments[i])
                        if ta == nil {
                            argsResolved = false
                            break
                        }
                        symbolic.Add(ta)
                        if ta.ClrType == nil {
                            // Issue #313 / #671: in-scope type parameter or
                            // user-defined G# type argument — close with a
                            // System.Object placeholder and preserve the
                            // symbolic argument for the emitter to recover.
                            hasSymbolicArg = true
                            clrArgs[i] = $scope.References!!.GetCoreType("System.Object")
                            continue
                        }
                        // Issue #3962: a fixed-length array `[N]T` HAS a CLR type
                        // (`T[]`), but it is the same one `[]T` and every other
                        // length carry, so the declared length survives only in
                        // the symbol. Retain it, or `List[[3]int32]` and
                        // `List[[4]int32]` resolve to one cached symbol here too.
                        // Issue #4024: the SLICE spelling `[]T` shares that
                        // backing and is retained by the same gate, so a
                        // fully-qualified
                        // `System.Collections.Generic.List[[]int32]()` is
                        // distinguishable from a metadata `List<int[]>`.
                        if TypeSymbol.ContainsSourceArrayShape(ta) {
                            hasSymbolicArg = true
                        }
                        // Type arguments resolve to gsc-host CLR types (e.g.
                        // primitives map to host typeof(...)), but openType may
                        // come from the resolver's isolated MetadataLoadContext.
                        // MakeGenericType requires every argument to share the
                        // open generic's load context, so project each argument
                        // onto the resolver's reference set first.
                        clrArgs[i] = $scope.References!!.MapClrTypeToReferences(ta.ClrType)!!
                    }
                    if !argsResolved {
                        continue
                    }
                    // Issue #4032 (review finding 1): a static member reached
                    // through a closed imported generic — `Handler[string].Describe()`
                    // — closes the type here, and this site did not ask the
                    // constraints either. Measured: it emitted an instantiation the
                    // CLR refuses and threw TypeLoadException.
                    if Binder.ReportUnsatisfiedGenericTypeConstraint(
                        Diagnostics,
                        openType,
                        clrArgs,
                        symbolic.ToImmutable(),
                        typeArgumentList.Location
                    ) {
                        return false
                    }
                    try {
                        clrType = openType!!.MakeGenericType(clrArgs)
                        if hasSymbolicArg {
                            openGenericDefinition = openType
                            symbolicTypeArgs = symbolic.MoveToImmutable()
                        }
                        return true
                    } catch (ArgumentException) {
                        continue
                    }
                }
            } else {
                let fullName = prefix + "." + typeSimpleName
                if $scope.References!!.TryResolveType(fullName, out var resolved) &&
                    !resolved!!.IsGenericTypeDefinition {
                    clrType = resolved
                    return true
                }
            }
        }
        // Issue #569: the dotted prefix may name an outer type (not a namespace),
        // with the terminal identifier being a nested type. Try resolving the
        // prefix as a type and then walking the terminal name as a nested type.
        // This covers `Outer.Inner()`, `Ns.Outer.Inner()`, and deeply-nested
        // chains like `Outer.Middle.Inner()` where the prefix segments include
        // both namespace and outer-type components.
        if TryResolveAsNestedTypeChain(namespacePrefix, typeSimpleName, arity, typeArgumentList, out clrType) {
            return true
        }
        return false
    }

    /// Issue #569: resolves a dotted prefix + terminal name as an outer type
    /// containing a nested type. The prefix is split at each dot position to
    /// find the outer type, then remaining segments and the terminal name are
    /// walked as nested types via (cref:ReferenceResolver.TryResolveNestedType).
    private func TryResolveAsNestedTypeChain(
        namespacePrefix string,
        typeSimpleName string,
        arity int32,
        typeArgumentList TypeArgumentListSyntax?,
        @NotNullWhen(true) out clrType Type?
    ) bool {
        clrType = nil
        if string.IsNullOrEmpty(namespacePrefix) {
            return false
        }
        let prefixSegments = namespacePrefix.Split('.')
        // Try each split point: first N segments are a type name, remaining
        // segments + terminal name are nested types. Start from the longest
        // outer prefix (most specific) first.
        for var outerLen = prefixSegments.Length; outerLen >= 1; outerLen-- {
            let outerName = string.Join(".", prefixSegments, 0, outerLen)
            var outerType Type? = nil
            // Try resolving the outer name directly.
            if !$scope.References!!.TryResolveType(outerName, out outerType) {
                // Try with each import prefix.
                for import_ in $scope.GetDeclaredImports() {
                    let qualified = import_.Target + "." + outerName
                    if $scope.References!!.TryResolveType(qualified, out outerType) {
                        break
                    }
                }
            }
            if outerType == nil {
                continue
            }
            // Walk remaining prefix segments as nested types.
            var current = outerType
            var walkFailed = false
            for var i = outerLen; i < prefixSegments.Length; i++ {
                if !$scope.References!!.TryResolveNestedType(current, prefixSegments[i], out var next) {
                    walkFailed = true
                    break
                }
                current = next!!
            }
            if walkFailed {
                continue
            }
            // Now resolve the terminal name as a nested type of `current`.
            var nestedType Type? = nil
            if arity > 0 {
                if typeArgumentList == nil {
                    return false
                }
                $scope.References!!.TryResolveNestedType(
                    current,
                    typeSimpleName + "`" + arity.ToString(),
                    out nestedType
                )
            }
            if nestedType == nil {
                $scope.References!!.TryResolveNestedType(current, typeSimpleName, out nestedType)
            }
            if nestedType == nil {
                continue
            }
            // Close the generic if type arguments are supplied.
            if arity > 0 && nestedType.IsGenericTypeDefinition {
                if typeArgumentList is not TypeArgumentListSyntax typeArguments {
                    return false
                }
                let clrArgs = [arity]Type
                var argsResolved = true
                for var i = 0; i < arity; i++ {
                    let ta = bindTypeClause(typeArguments.Arguments[i])
                    if ta?.ClrType is not Type taClrType {
                        argsResolved = false
                        break
                    }
                    clrArgs[i] = $scope.References!!.MapClrTypeToReferences(taClrType)!!
                }
                if !argsResolved {
                    continue
                }
                try {
                    clrType = nestedType.MakeGenericType(clrArgs)
                    return true
                } catch (ArgumentException) {
                    continue
                }
            } else if nestedType.IsGenericTypeDefinition {
                continue
            }
            clrType = nestedType
            return true
        }
        return false
    }

    /// Issue #1323: binds a (cref:GenericNameExpressionSyntax) that
    /// appears in value position rather than as a member-access receiver. A
    /// constructed generic type reference is not itself a value, so this reports
    /// a diagnostic. (In practice the parser only emits this node immediately
    /// before a `.` member access, which (cref:BindAccessorExpression)
    /// handles via the accessor leftPart switch.)
    private func BindGenericNameExpression(syntax GenericNameExpressionSyntax) BoundExpression {
        Diagnostics.ReportExpressionMustHaveValue(syntax.Location)
        return BoundErrorExpression(nil)
    }
}
