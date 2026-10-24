// <copyright file="ExpressionBinder.Access.Accessor.cs" company="GSharp">
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
import GSharp.Core.CodeAnalysis.Binding.OverloadResolution
import GSharp.Core.CodeAnalysis.Lowering
import GSharp.Core.CodeAnalysis.Lowering.Async
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Emit
import System.Globalization

internal partial class ExpressionBinder {
    private func BindAccessorExpression(syntax AccessorExpressionSyntax) BoundExpression {
        // Issue #1323: a GenericNameExpression only arises from the parser as the
        // receiver of a member access; the accessor leftPart switch below resolves
        // it to a constructed generic type. See BindGenericNameExpression for the
        // standalone (non-receiver) diagnostic path.
        // Phase 3.C.3b / ADR-0001: null-conditional access `lhs?.rhs`.
        // Evaluate the receiver once, capture it into a synthetic local,
        // then bind the rest of the access against the capture so the
        // subtree can be evaluated against the non-nil value without a
        // second evaluation of the receiver expression.
        if syntax.IsNullConditional {
            return BindNullConditionalAccessExpression(syntax)
        }
        var missingQualifiedType SyntaxToken? = nil
        var invalidQualifiedGenericType SyntaxToken? = nil
        var invalidQualifiedTypeArgument ExpressionSyntax? = nil
        var resolvedPrefix string? = nil
        var resolvedPrefixIsPackage = false
        var qualifiedClrFailureHandled = false
        // Issue #293: a fully-qualified imported-type constructor
        // (`System.Text.StringBuilder()`, `System.Collections.Generic.List[int]()`)
        // parses as an accessor chain whose terminal segment is the call, so it
        // never reaches the simple-name constructor path in BindCallExpression.
        // Resolve it the same way here so construction works identically whether
        // written as a simple name or a fully-qualified path, at top level and
        // inside function/method bodies alike.
        if TryBindQualifiedClrConstructorCall(syntax, out var qualifiedCtorCall) {
            return qualifiedCtorCall!!
        }
        // Issue #2258: a fully-qualified imported-type object-initializer
        // literal (`System.Text.Json.JsonWriterOptions{ Indented: true }`)
        // parses as an accessor chain whose terminal segment is the struct
        // literal, so it never reaches the simple-name literal path below.
        if TryBindQualifiedClrStructLiteral(syntax, out var qualifiedClrLiteral) {
            return qualifiedClrLiteral!!
        }
        // Resolve an exact CLR namespace/type path before the flat source-type
        // fallback below can select an unrelated same-simple-name source type.
        if !syntax.IsNullConditional &&
            !QualifiedAccessStartsWithValue(syntax) &&
            syntax.LeftPart is NameExpressionSyntax qualifiedClrRoot &&
            !(syntax.RightPart is NameExpressionSyntax) {
            var qualifiedClrMember = syntax.RightPart
            if TryBindFullyQualifiedClrStaticAccess(
                qualifiedClrRoot,
                &qualifiedClrMember,
                out var qualifiedClrType,
                out missingQualifiedType,
                out resolvedPrefix,
                out resolvedPrefixIsPackage,
                out qualifiedClrFailureHandled,
                out invalidQualifiedGenericType,
                out invalidQualifiedTypeArgument
            ) {
                return BindAccessorStep(nil, qualifiedClrType, qualifiedClrMember)
            }
        }
        // A same-compilation SOURCE type constructed/referenced through a
        // package-qualified name — `Oahu.Decrypt.Mp4Operation(...)`,
        // `Oahu.Decrypt.Mp4Operation[TResult](...)`. Source types are visible by
        // simple name across packages, but the qualified path above only resolves
        // CLR-backed reference types (a source type has no CLR type at bind time).
        // When the leading segments are a pure namespace/package prefix (none names
        // a value, type, import, or imported class) and the terminal simple name
        // is a user aggregate, peel the redundant prefix and bind the terminal by
        // simple name. cs2gs fully-qualifies constructor calls, so this is the
        // common translated shape.
        if TryBindQualifiedSourceTypeConstruction(syntax, out var qualifiedSourceCtor) {
            return qualifiedSourceCtor!!
        }
        // Issue #1069: a nested user type referenced by a qualified name from
        // outside its enclosing type (`Outer.Entry(...)`, `Outer.Inner().M()`).
        // Keep the enclosing receiver when binding nested construction/member
        // access, just as for a constructed generic receiver below. Simple-name
        // rebinding would lose the owner or select a top-level homonym. This
        // only fires when the next segment names a nested type; a bare terminal
        // name remains a type receiver handled below.
        if syntax.LeftPart is NameExpressionSyntax enclosingNameSyntax &&
            !(syntax.RightPart is NameExpressionSyntax) &&
            !($scope.TryLookupSymbol(enclosingNameSyntax.IdentifierToken.ValueText) is VariableSymbol) &&
            TryLookupSourceTypeWithImportPrecedence(
            enclosingNameSyntax.IdentifierToken.ValueText,
            preferredArity: -1,
            enclosingNameSyntax,
            out var enclosingAliasType
        ) &&
            IsUserAggregateType(enclosingAliasType!!) &&
            TryGetHeadIdentifier(syntax.RightPart, out var headIdentifier) {
            // Qualified source construction uses the same receiver-aware path
            // whether the enclosing type is generic or nongeneric (#4803).
            if enclosingAliasType is StructSymbol enclosingStruct && IsNestedTypeOf(headIdentifier!!, enclosingStruct) {
                return BindUserTypeStaticAccessorStep(enclosingStruct, syntax.RightPart)
            }
            // No collision (the nested type still holds its simple key): peel off
            // the redundant enclosing-type qualifier and bind the remainder by
            // simple name. This mirrors how the enclosing type's own members
            // reference a sibling nested type.
            if IsNestedTypeOf(headIdentifier!!, enclosingAliasType!!) {
                return BindExpression(syntax.RightPart)
            }
            // Issue #2203: a type whose simple name equals the last segment of
            // its own containing package (e.g. `class Tokens` in `package
            // Oahu.Cli.Tui.Tokens`) is referenced from outside that package as
            // `Tokens.Tokens.Member` — mirroring the C# idiom where a nested
            // namespace is visible unqualified from a sibling namespace under a
            // shared ancestor, which cs2gs translates literally since G# has no
            // equivalent namespace-visibility rule. The leading "Tokens" plays
            // the namespace's role and is redundant (G# resolves the trailing
            // "Tokens" type by simple name from its flat, cross-package type
            // scope regardless), so peel it off the same way as the
            // nested-type case above whenever the qualifier names the type's own
            // simple name AND that name is also the tail of its package.
            if headIdentifier == enclosingNameSyntax
                .IdentifierToken
                .ValueText &&
                GetSymbolPackageName(enclosingAliasType!!) is string ownPackageName &&
                (
                ownPackageName == headIdentifier || ownPackageName.EndsWith(
                    "." + headIdentifier,
                    StringComparison.Ordinal
                )
            ) {
                return BindExpression(syntax.RightPart)
            }
        }
        // Determine what the left side of the accessor is: either an imported
        // class (for static member access) or a value-producing expression (for
        // instance member access). Then apply the right side, which may itself
        // be a chain of accessors (e.g. Guid.NewGuid().ToString()).
        let leftPart = syntax.LeftPart
        var rightPart = syntax.RightPart
        let leftName NameExpressionSyntax? = leftPart as NameExpressionSyntax
        var receiver BoundExpression? = nil
        var classSymbol ImportedClassSymbol? = nil
        var enumSymbol EnumSymbol? = nil
        var userStructSymbol StructSymbol? = nil
        var userInterfaceSymbol InterfaceSymbol? = nil
        if leftName == nil {
            let genericTypeIndex IndexExpressionSyntax? = leftPart as IndexExpressionSyntax
            if genericTypeIndex != nil && !genericTypeIndex.IsNullConditional {
                if TryResolveConstructedGenericTypeReceiver(
                    genericTypeIndex,
                    out var indexedStruct,
                    out var indexedInterface,
                    out var indexedImported,
                    out var indexedFailureHandled
                ) {
                    return BindConstructedGenericTypeAccessorStep(
                        indexedStruct,
                        indexedInterface,
                        indexedImported,
                        rightPart,
                        leftPart
                    )
                }
                // Issue #4051: THIS is the site the cascade came from — not the
                // `else if` chain further down. When the resolver fails the
                // whole method falls through to `receiver =
                // BindExpression(leftPart)` a few lines below, which binds
                // `Nullable[string]` as an ordinary INDEX expression and looks
                // up `Nullable` and `string` as values — two `GS0125 Variable
                // 'X' doesn't exist` beside the accurate GS0152, one of them
                // naming a predefined type keyword. The construction already
                // explained why it is invalid; stop here.
                if indexedFailureHandled {
                    return BoundErrorExpression(syntax)
                }
            }
            let genericTypeName GenericNameExpressionSyntax? = leftPart as GenericNameExpressionSyntax
            if genericTypeName != nil {
                if TryResolveConstructedGenericTypeReceiver(
                    genericTypeName,
                    out var namedStruct,
                    out var namedInterface,
                    out var namedImported,
                    out var namedFailureHandled
                ) {
                    return BindConstructedGenericTypeAccessorStep(
                        namedStruct,
                        namedInterface,
                        namedImported,
                        rightPart,
                        leftPart
                    )
                }
                // Issue #4051: the generic-NAME shape of the same fall-through.
                // `Handler[string?].Describe()` added `GS0124 Expression must
                // have a value` and `GS0159 Cannot find function Describe`.
                if namedFailureHandled {
                    return BoundErrorExpression(syntax)
                }
            }
        }
        if leftName == nil {
            receiver = BindExpression(leftPart)
        }
        if leftName != nil {
            let name = leftName.IdentifierToken.ValueText
            let variableHit VariableSymbol? = $scope.TryLookupSymbol(name) as VariableSymbol
            // Issue #1104: `base.Prop` — a non-virtual read of the nearest base
            // class implementation of property `Prop`, mirroring C# `base.Prop`.
            // `base` is a contextual keyword: only intercepted when it is not a
            // real value in scope (so a hypothetical local named `base` still
            // wins).
            if IsContextualBaseKeyword(leftName) && rightPart is NameExpressionSyntax basePropName {
                return BindBaseClassPropertyRead(
                    basePropName,
                    leftName.Location,
                    explicitBaseType: nil,
                    selectorLocation: leftName.Location
                )
            }
            // Issue #1147 (Facet A — "Color Color" + unified overload
            // resolution): when the receiver name binds to BOTH an in-scope
            // value AND a same-named user struct/class, and the right-hand side
            // is a CALL to a method declared as BOTH an instance and a static
            // (`shared`) overload, neither the value nor the type interpretation
            // is correct on its own. Resolve the call against the COMBINED
            // instance + static overload set (C# §12.8.7.1) and route by the
            // selected method's IsStatic: an instance overload binds the VALUE
            // as the receiver; a static overload binds against the TYPE. This is
            // strictly scoped to the both-buckets-non-empty case, so a
            // static-only member name still falls through to the #687 type path
            // below and an instance-only name still falls through to the
            // value/instance path — both unchanged.
            if variableHit != nil &&
                rightPart is CallExpressionSyntax colorColorCall &&
                TryResolveColorColorType(name, leftName, out _, out var unifiedColorStruct, out _, out _) &&
                unifiedColorStruct != nil &&
                TryBindColorColorUnifiedCall(unifiedColorStruct, leftName, colorColorCall, out var unifiedColorResult) {
                return unifiedColorResult!!
            }
            // Issue #687 (Option A — C#-style "color color"): when an identifier
            // resolves to both a value (field/local/parameter) AND a same-named
            // type in scope, prefer the type interpretation if the right-hand
            // side of the accessor is a static member of that type. Fall through
            // to the value interpretation otherwise so instance access continues
            // to bind as today (`field.InstanceMethod()`).
            if variableHit != nil &&
                TryResolveColorColorType(
                name,
                leftName,
                out var colorClassSymbol,
                out var colorStructSymbol,
                out var colorInterfaceSymbol,
                out var colorEnumSymbol
            ) &&
                RightPartLooksLikeStaticMember(
                colorClassSymbol,
                colorStructSymbol,
                colorInterfaceSymbol,
                colorEnumSymbol,
                rightPart
            ) {
                if colorClassSymbol != nil {
                    classSymbol = colorClassSymbol
                } else if colorStructSymbol != nil {
                    userStructSymbol = colorStructSymbol
                } else if colorInterfaceSymbol != nil {
                    userInterfaceSymbol = colorInterfaceSymbol
                } else {
                    enumSymbol = colorEnumSymbol
                }
            } else if variableHit is VariableSymbol variable {
                if variable is ImplicitFieldVariableSymbol implicitField {
                    // Bare field name inside a method: rebind as `this.field`
                    // so chained access (`Field.Sub`) emits a load of the
                    // backing field through the `this` receiver.
                    // Issue #186 / #175: implicit field as accessor receiver
                    // fires GS0204 if the field carries `@Obsolete`.
                    reportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitField.Field,
                        "${implicitField.StructType.Name}.${implicitField.Field.Name}"
                    )
                    // Issue #208: apply any [MemberNotNull] narrowing so that
                    // chained access like `_name.Length` after a [MemberNotNull]
                    // call is accepted without a nil-guard.
                    let makeNarrowedField(TypeSymbol) -> BoundExpression = (
                        narrowedType TypeSymbol
                    ) -> BoundFieldAccessExpression(
                        leftName,
                        BoundVariableExpression(nil, implicitField.Receiver),
                        implicitField.StructType,
                        implicitField.Field,
                        narrowedType
                    )
                    receiver = BuildNarrowedRead(
                        BoundFieldAccessExpression(
                            leftName,
                            BoundVariableExpression(nil, implicitField.Receiver),
                            implicitField.StructType,
                            implicitField.Field
                        ),
                        implicitField.Field.Type,
                        TryGetNarrowedType(implicitField, leftName.Location),
                        makeNarrowedField
                    )
                } else if variable is ImplicitStaticFieldVariableSymbol implicitStaticField {
                    // Issue #261: bare static field name as accessor receiver
                    // inside a shared method body.
                    reportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitStaticField.Field,
                        "${implicitStaticField.OwnerName}.${implicitStaticField.Field.Name}"
                    )
                    // Issue #1030: an interface-owned static field carries its
                    // owning interface (self-instantiation for a generic
                    // interface) so emit/interpreter resolve it correctly.
                    receiver = if implicitStaticField.InterfaceType != nil {
                        BoundFieldAccessExpression(nil, implicitStaticField.Field, implicitStaticField.InterfaceType)
                    } else {
                        BoundFieldAccessExpression(
                            nil,
                            receiver: nil,
                            implicitStaticField.StructType,
                            implicitStaticField.Field
                        )
                    }
                } else if variable is ImplicitStaticPropertyVariableSymbol implicitStaticProp {
                    // ADR-0053: bare static property name as accessor receiver
                    // (e.g., `StaticProp.Sub` inside a method body of the
                    // enclosing type).
                    reportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitStaticProp.Property,
                        "${implicitStaticProp.StructType.Name}.${implicitStaticProp.Property.Name}"
                    )
                    if !implicitStaticProp.Property.HasGetter {
                        Diagnostics.ReportCannotAssign(
                            leftName.IdentifierToken.Location,
                            implicitStaticProp.Property.Name
                        )
                        return BoundErrorExpression(nil)
                    }
                    receiver = BoundPropertyAccessExpression(
                        nil,
                        receiver: nil,
                        implicitStaticProp.StructType,
                        implicitStaticProp.Property
                    )
                } else if variable is ImplicitPropertyVariableSymbol implicitProp {
                    // Issue #1339: a bare instance-property name used as the
                    // receiver of a member access (`Prop.Member`, e.g.
                    // `Entries.Values`/`Items.Count`) must rebind as
                    // `this.Prop` so the getter call is emitted before the
                    // member access. Without this the property falls through to
                    // the bare-variable case below and emits as a load of a
                    // non-existent local slot named after the property (GS9998).
                    // Mirrors the static-property arm above and the standalone
                    // bare-name path in BindNameExpression.
                    reportObsoleteUseIfApplicable(
                        leftName.IdentifierToken.Location,
                        implicitProp.Property,
                        "${implicitProp.StructType.Name}.${implicitProp.Property.Name}"
                    )
                    if !implicitProp.Property.HasGetter {
                        Diagnostics.ReportCannotAssign(leftName.IdentifierToken.Location, implicitProp.Property.Name)
                        return BoundErrorExpression(nil)
                    }
                    receiver = BoundPropertyAccessExpression(
                        nil,
                        BoundVariableExpression(nil, implicitProp.Receiver),
                        implicitProp.StructType,
                        implicitProp.Property
                    )
                } else {
                    // Preserve the name anchor when this fast path bypasses
                    // BindExpression, so semantic lookup sees the selected local.
                    let makeNarrowedVariable(TypeSymbol) -> BoundExpression = (
                        narrowedType TypeSymbol
                    ) -> BoundVariableExpression(leftName, variable, narrowedType)
                    receiver = BuildNarrowedRead(
                        BoundVariableExpression(leftName, variable),
                        variable.Type,
                        TryGetNarrowedType(variable, leftName.Location),
                        makeNarrowedVariable
                    )
                }
                // Issues #4287 and #4310: a bare member name rebinds as
                // `this.member` (or `Type.member`) above, and so does the nil
                // test that guards it:
                // `memo != nil` binds `memo` as a field access, and ADR-0069
                // records that narrowing under the member's AccessPath, not under
                // the implicit VariableSymbol the branches above look up. So
                // `this.memo.TryGetValue(…)` was narrowed after the guard while
                // `memo.TryGetValue(…)` was not. Consult the path too, the same way
                // an explicit `this.memo` receiver does. This returns the read
                // unchanged when it already carries a narrowing.
                if variable is ImplicitFieldVariableSymbol ||
                    variable is ImplicitStaticFieldVariableSymbol ||
                    variable is ImplicitPropertyVariableSymbol ||
                    variable is ImplicitStaticPropertyVariableSymbol {
                    receiver!!.AnchorSyntax(leftName)
                    receiver = ApplyMemberNarrowing(receiver!!)
                }
            } else if TryBindInheritedClrInstanceMemberByBareName(name, out var inheritedClrHead) {
                // Issue #2809: an unqualified accessor chain whose head is an
                // inherited CLR property/field (`Clients.All()`) must bind as
                // `this.Clients.All()`. Preserve #687's type/value collision
                // rule: a same-named type still wins when the right side is one
                // of its static members (`Path.Combine(...)`).
                if TryResolveColorColorType(
                    name,
                    leftName,
                    out var inheritedColorClass,
                    out var inheritedColorStruct,
                    out var inheritedColorInterface,
                    out var inheritedColorEnum
                ) &&
                    RightPartLooksLikeStaticMember(
                    inheritedColorClass,
                    inheritedColorStruct,
                    inheritedColorInterface,
                    inheritedColorEnum,
                    rightPart
                ) {
                    classSymbol = inheritedColorClass
                    userStructSymbol = inheritedColorStruct
                    userInterfaceSymbol = inheritedColorInterface
                    enumSymbol = inheritedColorEnum
                } else {
                    inheritedClrHead?.AnchorSyntax(leftName)
                    return BindAccessorStep(inheritedClrHead, nil, rightPart)
                }
            } else if TryResolveInterfaceInstancePropertyByBareName(name, out _, out _) &&
                !(
                TryResolveColorColorType(
                    name,
                    leftName,
                    out var dimColorClass,
                    out var dimColorStruct,
                    out var dimColorInterface,
                    out var dimColorEnum
                ) &&
                    RightPartLooksLikeStaticMember(
                    dimColorClass,
                    dimColorStruct,
                    dimColorInterface,
                    dimColorEnum,
                    rightPart
                )
            ) {
                // Issue #3840: an unqualified accessor chain inside a DEFAULT
                // INTERFACE METHOD body whose head names the enclosing
                // interface's own property (`Count.ToString()`) binds as
                // `this.Count.ToString()`. Mirrors the inherited-CLR arm above,
                // including #687's type/value collision rule (a same-named type
                // wins on the static-member shape, by falling through to the
                // source-type arms below).
                return if TryBindInterfaceInstancePropertyByBareName(leftName, out var dimHead) {
                    BindAccessorStep(dimHead, nil, rightPart)
                } else {
                    cast[BoundExpression](BoundErrorExpression(nil))
                }
            } else if TryBindSubmissionStaticMember(leftName, out var submissionHead) &&
                !(submissionHead is BoundErrorExpression) {
                // ADR-0156 Phase 2: an accessor chain whose head names a
                // top-level global (or function) of a prior interactive
                // submission — e.g. `p.Sum()` where `p` was declared in an
                // earlier cell — binds the head as the submission's static
                // field read and continues the chain on that value.
                submissionHead?.AnchorSyntax(leftName)
                return BindAccessorStep(submissionHead, nil, rightPart)
            } else if binderCtx.TryLookupSourceType(
                $scope,
                name,
                preferredArity: 0,
                getCurrentFunction(),
                out var typeAlias,
                out _
            ) {
                if TryResolveImportedTypeOverride(
                    name,
                    typeAlias!!,
                    requestedArity: 0,
                    leftName,
                    out var importedStaticCandidate
                ) {
                    classSymbol = importedStaticCandidate
                } else if typeAlias is EnumSymbol foundEnum {
                    enumSymbol = CloseNestedEnumOverCurrentTypeParameters(foundEnum)
                } else if typeAlias is StructSymbol foundStruct {
                    userStructSymbol = foundStruct
                } else if typeAlias is InterfaceSymbol foundInterface {
                    // ADR-0089 / issue #1030: `IName.StaticField` — qualified
                    // access to an interface static field (storage or const).
                    userInterfaceSymbol = foundInterface
                } else {
                    Diagnostics.ReportUnableToFindType(leftName.Location, name)
                    return BoundErrorExpression(nil)
                }
            } else if $scope.TryLookupImport(name, out var matchedImport) &&
                TryBindImportAccessor(matchedImport!!, &rightPart, out var typeFromImport) {
                classSymbol = typeFromImport
            } else if $scope.TryLookupImport(name, out var matchedTypeAliasImport) &&
                matchedTypeAliasImport!!.IsAlias &&
                lookupType(name) is TypeSymbol aliasedType {
                // Issue #2273: `import R = Namespace.Type` where the aliased
                // target is a same-compilation SOURCE type (a class/struct,
                // enum, or interface declared elsewhere in this compilation —
                // e.g. the conventional resx `import R = ...Properties.Resources`
                // pattern) rather than a CLR type. `TryBindImportAccessor` above
                // only resolves CLR alias targets via the reference resolver, so
                // a source-type alias falls through to here; `lookupType` (bound
                // to `Binder.LookupType`) now also resolves an alias's target
                // through the same import, so it recovers the aliased type
                // symbol directly.
                if aliasedType is EnumSymbol foundAliasEnum {
                    enumSymbol = CloseNestedEnumOverCurrentTypeParameters(foundAliasEnum)
                } else if aliasedType is StructSymbol foundAliasStruct {
                    userStructSymbol = foundAliasStruct
                } else if aliasedType is InterfaceSymbol foundAliasInterface {
                    userInterfaceSymbol = foundAliasInterface
                } else if aliasedType.ClrType != nil {
                    classSymbol = ImportedClassSymbol(aliasedType.ClrType, leftName, references: $scope.References)
                } else {
                    Diagnostics.ReportUnableToFindType(leftName.Location, name)
                    return BoundErrorExpression(nil)
                }
            } else if $scope.TryLookupImportedClass(name, leftName, out var importedClass, out var ambiguity) {
                // Issue #3734: the receiver still binds first-import-wins, but
                // the choice came from import order, not from the source.
                if ambiguity != nil {
                    Diagnostics.ReportAmbiguousImportedTypeReference(leftName.Location, name, ambiguity)
                }
                classSymbol = importedClass
            } else if binderCtx.CurrentTypeParameters != nil && binderCtx.CurrentTypeParameters!!.TryGetValue(
                name,
                out var tpSym
            ) {
                // ADR-0089 / issue #755: `T.Member(args)` where `T` is a
                // generic type parameter with an interface constraint
                // dispatches to a static-virtual interface member. We
                // delegate to a helper that resolves the rightPart against
                // the constraint interface's static-virtual table.
                return BindTypeParameterStaticAccessorStep(tpSym, leftName, rightPart)
            } else if leftName.IdentifierToken.Text == "bytestring" && binderCtx.CanUseIntrinsicAlias(
                $scope,
                leftName.IdentifierToken,
                getCurrentFunction(),
                expression: true
            ) {
                if !ByteStringTypes.TryResolveDefinition($scope.References!!, out var byteStringType) {
                    Diagnostics.ReportByteStringRuntime(leftName.Location)
                    return BoundErrorExpression(syntax)
                }
                classSymbol = ImportedClassSymbol(byteStringType, leftName, references: $scope.References)
            } else if TryResolvePredefinedTypeReceiver(name, leftName, out var predefinedClass) {
                // Issue #919: a lowercase predefined primitive type alias used as
                // the receiver of a static member access (e.g. `string.Empty`,
                // `int32.MaxValue`). The earlier import/alias lookups only match
                // the capitalized CLR name (`String`, `Int32`); the keyword form
                // is resolved here to the same underlying CLR type so static
                // member access binds identically to the capitalized form.
                classSymbol = predefinedClass
            } else if !(rightPart is NameExpressionSyntax) &&
                TryBindFullyQualifiedClrStaticAccess(leftName, &rightPart, out var fullyQualifiedClrClass) {
                // Issue #2258: a fully-qualified CLR type reference whose leading
                // segment is not a registered import — e.g.
                // `Microsoft.Extensions.Logging.LogLevel.Warning`. cs2gs emits the
                // full namespace path; walk it to the referenced CLR type and bind
                // the trailing member as a static access. Gated on the right part
                // being a further chain (not a bare terminal name) so a genuine
                // undefined single-segment name still reports GS0157 below.
                classSymbol = fullyQualifiedClrClass
            } else if binderCtx.PatternVariableNames.Contains(name) {
                // ADR-0166: `t.Member` where `t` is a pattern variable read
                // outside the region its match dominates — a definite-
                // assignment error, not a missing type.
                Diagnostics.ReportPatternVariableNotDefinitelyAssigned(leftName.Location, name)
                return BoundErrorExpression(nil)
            } else {
                if qualifiedClrFailureHandled {
                    return BoundErrorExpression(syntax)
                }
                if invalidQualifiedTypeArgument != nil {
                    let invalidArgumentLocation = invalidQualifiedTypeArgument.Location
                    Diagnostics.ReportUnableToFindType(
                        invalidArgumentLocation,
                        invalidArgumentLocation.Text?.ToString(invalidArgumentLocation.Span) ?? string.Empty
                    )
                    return BoundErrorExpression(syntax)
                }
                if invalidQualifiedGenericType != nil {
                    Diagnostics.ReportTypeNotGeneric(
                        invalidQualifiedGenericType.Location,
                        invalidQualifiedGenericType.ValueText
                    )
                    return BoundErrorExpression(syntax)
                }
                if missingQualifiedType != nil && resolvedPrefix != nil {
                    // Issue #3842: report the deepest verified namespace/package
                    // boundary after every existing receiver path has failed.
                    Diagnostics.ReportUnableToFindQualifiedType(
                        missingQualifiedType.Location,
                        missingQualifiedType.ValueText,
                        resolvedPrefix,
                        resolvedPrefixIsPackage
                    )
                    return BoundErrorExpression(syntax)
                }
                Diagnostics.ReportUnableToFindType(leftName.Location, name)
                return BoundErrorExpression(nil)
            }
        } else if leftPart is IndexExpressionSyntax genericTypeIndex &&
            !genericTypeIndex.IsNullConditional &&
            TryResolveConstructedGenericTypeReceiver(
            genericTypeIndex,
            out var constructedStruct,
            out var constructedInterface,
            out var constructedImported
        ) {
            // Issue #1209 (extends ADR-0089 / issue #1030): a generic-type
            // reference with explicit type arguments used in expression /
            // member-access receiver position — `Box[int32].Default`,
            // `ArrayPool[uint8].Shared`, `Comparer[int32].Default`. The parser
            // shapes `Name[Arg]` as an index expression; when `Name` is NOT a
            // value but IS a generic type definition of matching arity (user
            // class/struct, user interface, or imported CLR generic), bind the
            // whole `Name[Arg]` as the constructed generic *type* receiver
            // rather than as element access. The closed construction is carried
            // so static-member access (and static method calls) resolve against
            // the construction.
            if constructedInterface != nil {
                userInterfaceSymbol = constructedInterface
            } else if constructedStruct != nil {
                userStructSymbol = constructedStruct
            } else {
                if constructedImported == nil {
                    return BoundErrorExpression(nil)
                }
                classSymbol = constructedImported
            }
        } else if leftPart is GenericNameExpressionSyntax genericTypeName &&
            TryResolveConstructedGenericTypeReceiver(
            genericTypeName,
            out var genericConstructedStruct,
            out var genericConstructedInterface,
            out var genericConstructedImported
        ) {
            // Issue #1323: a constructed generic *type* reference used as a
            // member-access receiver where the type argument is unambiguously a
            // type (`Box[int32?].Make(5)`, `Box[[]int32].Make(5)`,
            // `Box[List[int32]].Make(5)`, `Pair[int, string].Default`). The
            // parser emits a GenericNameExpression here (the bracket contents
            // cannot be reshaped from an index expression), so bind the closed
            // construction directly as the static-access receiver.
            if genericConstructedInterface != nil {
                userInterfaceSymbol = genericConstructedInterface
            } else if genericConstructedStruct != nil {
                userStructSymbol = genericConstructedStruct
            } else {
                if genericConstructedImported == nil {
                    return BoundErrorExpression(nil)
                }
                classSymbol = genericConstructedImported
            }
        } else if leftPart is AccessorExpressionSyntax qualifiedNestedType &&
            !qualifiedNestedType.IsNullConditional &&
            TryResolveQualifiedUserNestedType(qualifiedNestedType, out var qualifiedNestedSymbol) {
            // Issue #1069: a qualified nested *type* used as the receiver of a
            // further member access, e.g. `Outer.Color.Red` (the `Outer.Color`
            // sub-chain names the nested enum) or `Outer.Inner.StaticMember`.
            switch qualifiedNestedSymbol {
                case qualifiedEnum is EnumSymbol {
                    enumSymbol = qualifiedEnum
                }
                case qualifiedStruct is StructSymbol {
                    userStructSymbol = qualifiedStruct
                }
                case qualifiedInterface is InterfaceSymbol {
                    userInterfaceSymbol = qualifiedInterface
                }
                default {
                    receiver = BindExpression(leftPart)
                }
            }
        } else if leftPart is AccessorExpressionSyntax inheritedImportedNestedType &&
            !inheritedImportedNestedType.IsNullConditional &&
            TryResolveInheritedImportedNestedType(inheritedImportedNestedType, out var inheritedImportedNestedSymbol) {
            classSymbol = inheritedImportedNestedSymbol
        } else if leftPart is IndexExpressionSyntax nestedTypeIndex &&
            !nestedTypeIndex.IsNullConditional &&
            TryResolveUserNestedTypeExpression(nestedTypeIndex, out var nestedTypeIndexSymbol) {
            // Issue #1537: a per-segment generic nested-type chain whose deepest
            // segment carries a SINGLE type argument parses as an index over the
            // preceding accessor (`Outer[int32].Middle[string]` is
            // `((Outer[int32]).Middle)[string]`), so it never reaches the
            // NAME-target index branch above. Resolve it as the constructed
            // nested type receiver (`Outer`1+Middle`2<int32, string>`) so the
            // trailing member access / composite literal binds against a type
            // whose members substitute every enclosing level.
            switch nestedTypeIndexSymbol {
                case nestedIndexEnum is EnumSymbol {
                    enumSymbol = nestedIndexEnum
                }
                case nestedIndexStruct is StructSymbol {
                    userStructSymbol = nestedIndexStruct
                }
                case nestedIndexInterface is InterfaceSymbol {
                    userInterfaceSymbol = nestedIndexInterface
                }
                default {
                    receiver = BindExpression(leftPart)
                }
            }
        }
        if enumSymbol != nil {
            return BindEnumAccessorStep(enumSymbol, rightPart)
        }
        if userStructSymbol != nil {
            return BindUserTypeStaticAccessorStep(userStructSymbol, rightPart)
        }
        if userInterfaceSymbol != nil {
            return BindInterfaceStaticAccessorStep(userInterfaceSymbol, rightPart)
        }
        return BindAccessorStep(receiver, classSymbol, rightPart, leftPart)
    }

    private func BindConstructedGenericTypeAccessorStep(
        constructedStruct StructSymbol?,
        constructedInterface InterfaceSymbol?,
        constructedImported ImportedClassSymbol?,
        rightPart ExpressionSyntax,
        leftPart ExpressionSyntax
    ) BoundExpression {
        if constructedInterface != nil {
            return BindInterfaceStaticAccessorStep(constructedInterface, rightPart)
        }
        if constructedStruct != nil {
            return BindUserTypeStaticAccessorStep(constructedStruct, rightPart)
        }
        if constructedImported != nil {
            return BindAccessorStep(nil, constructedImported, rightPart, leftPart)
        }
        return BoundErrorExpression(nil)
    }

    private func TryResolveInheritedImportedNestedType(
        syntax AccessorExpressionSyntax,
        @NotNullWhen(true) out nestedClassSymbol ImportedClassSymbol?
    ) bool {
        nestedClassSymbol = nil
        var sourceType StructSymbol? = nil
        if syntax.LeftPart is NameExpressionSyntax sourceName &&
            TryLookupSourceTypeWithImportPrecedence(
            sourceName.IdentifierToken.ValueText,
            preferredArity: -1,
            sourceName,
            out var sourceAlias
        ) &&
            sourceAlias is StructSymbol namedSourceType {
            sourceType = namedSourceType
        } else if syntax.LeftPart is IndexExpressionSyntax constructedSource &&
            TryResolveConstructedGenericTypeReceiver(constructedSource, out var constructedStruct, out _, out _) {
            sourceType = constructedStruct
        } else if syntax.LeftPart is GenericNameExpressionSyntax genericSource &&
            TryResolveConstructedGenericTypeReceiver(genericSource, out var genericStruct, out _, out _) {
            sourceType = genericStruct
        }
        let importedBaseType = if sourceType == nil {
            default(TypeSymbol?)
        } else {
            TypeMemberModel.GetNearestImportedBase(sourceType)
        }
        if importedBaseType?.ClrType is not Type importedBase {
            return false
        }
        let importedBaseSymbol = CreateInheritedImportedClassSymbol(importedBaseType!!, syntax.LeftPart)
        if !TryResolveNestedTypeFromAccessorLeft(importedBaseSymbol, syntax.RightPart, out nestedClassSymbol) {
            return false
        }
        nestedClassSymbol = CloseImportedNestedType(
            importedBase,
            nestedClassSymbol!!,
            syntax.RightPart,
            importedBaseSymbol.SymbolicReceiver,
            importedBaseSymbol.ConstructedReceiver
        )
        return true
    }

    private func CreateInheritedImportedClassSymbol(
        importedType TypeSymbol,
        syntax ExpressionSyntax
    ) ImportedClassSymbol -> ImportedClassSymbol(
        Invariant.Required(importedType.ClrType, "an imported base has a CLR type", expression: "importedType.ClrType"),
        syntax,
        references: $scope.References,
        constructedReceiver: MemberLookup.GetProjectionReceiverImportedType(importedType)
    )

    private func CloseImportedNestedType(
        constructedOuter Type,
        nested ImportedClassSymbol,
        syntax ExpressionSyntax,
        symbolicOuter ImportedTypeSymbol?,
        constructedOuterSymbol ImportedTypeSymbol?
    ) ImportedClassSymbol {
        let nestedType = nested.ClassType
        if !constructedOuter.IsConstructedGenericType || !nestedType.ContainsGenericParameters {
            return nested
        }
        let outerArguments = constructedOuter.GetGenericArguments()
        if nestedType.GetGenericArguments().Length != outerArguments.Length {
            return nested
        }
        try {
            let closedType = nestedType.MakeGenericType(outerArguments)
            var symbolicNested ImportedTypeSymbol? = nil
            if symbolicOuter?.HasTypeParameterArgument == true &&
                symbolicOuter!!
                .TypeArguments
                .Length == nestedType
                .GetGenericArguments().Length {
                symbolicNested = ImportedTypeSymbol.GetConstructed(
                    closedType,
                    nestedType,
                    symbolicOuter!!.TypeArguments
                )
            }
            let constructedNested = if constructedOuterSymbol != nil &&
                constructedOuterSymbol
                .TypeArguments
                .Length == nestedType
                .GetGenericArguments().Length {
                ImportedTypeSymbol.GetConstructed(closedType, nestedType, constructedOuterSymbol.TypeArguments)
            } else {
                symbolicNested
            }
            return ImportedClassSymbol(closedType, syntax, symbolicNested, $scope.References, constructedNested)
        } catch (ArgumentException) {
            return nested
        }
    }

    private func CloseNestedEnumOverCurrentTypeParameters(
        enumSymbol EnumSymbol
    ) EnumSymbol -> EnumSymbol.ConstructNestedFromTypeParameterScope(enumSymbol, binderCtx.CurrentTypeParameters)!!

    /// Issue #1213: whether the function currently being bound belongs to
    /// [`type`](paramref) (or a type derived from it). Used to gate
    /// in-type resolution of a field-like event to its private backing
    /// delegate field, matching C# (an event name in expression position is
    /// only valid inside the declaring type).
    private func IsWithinType(type StructSymbol?) bool {
        if type == nil {
            return false
        }
        let enclosingType StructSymbol? = (this.function?.ReceiverType as StructSymbol) ??
            (this.function?.StaticOwnerType as StructSymbol)
        if enclosingType == nil {
            return false
        }
        for t in enclosingType.GetHierarchy() {
            if object.ReferenceEquals(t, type) ||
                (t.Declaration != nil && object.ReferenceEquals(t.Declaration, type.Declaration)) {
                return true
            }
        }
        return false
    }

    /// Issue #1069: whether [`name`](paramref) resolves to a user-defined
    /// type whose enclosing type is [`container`](paramref).
    private func IsNestedTypeOf(name string, container TypeSymbol) bool -> $scope.TryLookupNestedTypeAlias(
        container,
        name,
        preferredArity: -1,
        out var candidate
    ) &&
        IsUserAggregateType(candidate!!)

    /// Issue #1069: resolves a dotted accessor of the form
    /// `Outer.Nested` (optionally deeper, `A.B.C`) to the user-defined
    /// nested type it names, by walking the enclosing-type chain. Each segment
    /// after the first must name a user type whose enclosing type is the symbol
    /// resolved for the preceding segment. Returns `false` when
    /// the chain is not a pure user nested-type reference.
    private func TryResolveQualifiedUserNestedType(
        accessor AccessorExpressionSyntax,
        @NotNullWhen(true) out nestedType TypeSymbol?
    ) bool -> TryResolveUserNestedTypeExpression(accessor, out nestedType)

    /// Issue #1069/#1506/#1521/#1537: resolves an expression that names a
    /// (possibly nested, possibly per-segment generic) user type — e.g.
    /// `Outer.Middle`, `Outer[int32].Middle`,
    /// `Outer[int32].Middle[string]`, or the arbitrarily deep
    /// `Outer[int32].Middle[string].Inner[bool]` — to its constructed type
    /// symbol. The chain is flattened to per-segment (name, own type-arguments)
    /// pairs, each segment is resolved as a nested type of the previous one, and
    /// the deepest segment is constructed threading BOTH the flattened enclosing
    /// construction's arguments (outermost-first, occupying the low ordinals)
    /// and its own arguments, so member lookup substitutes every level and the
    /// emitter encodes the reified nested type (`Outer`1+Middle`2<int32,
    /// string>`). Generalizes to arbitrary depth and mixed generic /
    /// non-generic levels; a fully non-generic chain returns the definition
    /// unchanged (preserving #1069 behavior).
    /// @param expr The type-naming expression (accessor or index chain).
    /// @param nestedType The resolved (possibly constructed) type symbol.
    /// @returns Whether the expression resolved to a user nested type.
    private func TryResolveUserNestedTypeExpression(
        expr ExpressionSyntax,
        @NotNullWhen(true) out nestedType TypeSymbol?
    ) bool {
        nestedType = nil
        // Issue #942 regression guard: this probe speculatively binds each
        // bracketed segment's contents as TYPE arguments to decide whether
        // `expr` names a constructed nested type (#1537) rather than an indexer
        // receiver. In a genuine per-segment nested-type chain the ROOT names a
        // user aggregate TYPE (`Outer` in `Outer[int32].Middle[string]`); in a
        // real indexer the root is a VALUE — a local/parameter/field such as
        // `xs` in `xs[i]`. Gate on the head naming a user aggregate type (and
        // NOT a value) BEFORE binding any bracket as a type — mirroring
        // TryResolveConstructedGenericTypeReceiver — so a real indexer whose
        // index is an identifier is never probed as a nested type (which would
        // look the index up as a type and report a spurious GS0113).
        if !TryGetUserTypeChainHead(expr, out var headName, out var headArity) || $scope.TryLookupSymbol(
            headName
        ) is VariableSymbol ||
            !TryLookupSourceTypeWithImportPrecedence(headName!!, headArity, expr, out var headCandidate) ||
            !IsUserAggregateType(headCandidate!!) {
            return false
        }
        return TryResolveUserNestedTypeExpressionCore(expr, out nestedType)
    }

    /// Issue #1537: the flatten-and-construct core of
    /// (cref:TryResolveUserNestedTypeExpression). Invoked only after the
    /// wrapper has confirmed the chain head names a user aggregate type, so the
    /// speculative type-argument binding it performs cannot mistake a genuine
    /// indexer receiver for a nested-type chain.
    /// @param expr The type-naming expression (accessor or index chain).
    /// @param nestedType The resolved (possibly constructed) type symbol.
    /// @returns Whether the expression resolved to a user nested type.
    private func TryResolveUserNestedTypeExpressionCore(
        expr ExpressionSyntax,
        @NotNullWhen(true) out nestedType TypeSymbol?
    ) bool {
        nestedType = nil
        let segments = List[(Name string, Args ImmutableArray[TypeSymbol])]()
        if !TryFlattenUserTypeExpressionSegments(expr, segments) || segments.Count < 2 {
            return false
        }
        let headArity = if segments[0].Args.IsDefaultOrEmpty {
            -1
        } else {
            segments[0].Args.Length
        }
        if !TryLookupSourceTypeWithImportPrecedence(segments[0].Name, headArity, expr, out var headDef) ||
            !IsUserAggregateType(headDef!!) {
            return false
        }
        let definitions = [segments.Count]TypeSymbol
        definitions[0] = headDef!!
        for var i = 1; i < segments.Count; i++ {
            let containerDef = (definitions[i - 1] as StructSymbol)?.Definition ?? definitions[i - 1]
            let arity = if segments[i].Args.IsDefaultOrEmpty {
                -1
            } else {
                segments[i].Args.Length
            }
            if $scope.TryLookupNestedTypeAlias(containerDef, segments[i].Name, arity, out var nested) {
                definitions[i] = nested!!
            } else if definitions[i - 1] is StructSymbol containerStruct &&
                $scope
                .TryLookupNestedTypeAliasIncludingInherited(
                containerStruct,
                segments[i].Name,
                arity,
                out var inheritedNested,
                out var declaringContainer
            ) {
                definitions[i - 1] = declaringContainer!!
                definitions[i] = inheritedNested!!
            } else {
                return false
            }
        }
        // Thread the flattened enclosing construction's arguments (the own
        // arguments of every generic enclosing segment, outermost-first) onto
        // the deepest segment, together with its own arguments. A generic
        // enclosing segment left without matching arguments cannot be threaded,
        // so the whole chain stays open (mirrors the type-clause path's
        // CollectConstructedEnclosingArguments).
        var enclosingBuilder ImmutableArray[TypeSymbol].Builder? = ImmutableArray.CreateBuilder[TypeSymbol]()
        for var i = 0; i < segments.Count - 1; i++ {
            let ownParams = switch definitions[i] {
                case s is StructSymbol: (s.Definition ?? s).TypeParameters
                case iface is InterfaceSymbol: (iface.Definition ?? iface).TypeParameters
                default: ImmutableArray[TypeParameterSymbol].Empty
            }
            if ownParams.IsDefaultOrEmpty {
                continue
            }
            let constructionArgs = if definitions[i] is StructSymbol constructedStruct &&
                !constructedStruct
                .TypeArguments
                .IsDefaultOrEmpty {
                constructedStruct.TypeArguments
            } else {
                segments[i].Args
            }
            if constructionArgs.IsDefaultOrEmpty || constructionArgs.Length != ownParams.Length {
                enclosingBuilder = nil
                break
            }
            if definitions[i] is StructSymbol nestedConstruction &&
                !nestedConstruction
                .EnclosingTypeArguments
                .IsDefaultOrEmpty {
                enclosingBuilder!!.AddRange(nestedConstruction.EnclosingTypeArguments)
            }
            enclosingBuilder!!.AddRange(constructionArgs)
        }
        let enclosingArgs = if enclosingBuilder != nil && enclosingBuilder.Count > 0 {
            enclosingBuilder.ToImmutable()
        } else {
            default(ImmutableArray[TypeSymbol])
        }
        let ownArgs = segments[segments.Count - 1].Args
        switch definitions[segments.Count - 1] {
            case nestedStruct is StructSymbol {
                let def = nestedStruct.Definition ?? nestedStruct
                if !enclosingArgs.IsDefaultOrEmpty && !ownArgs.IsDefaultOrEmpty {
                    nestedType = StructSymbol.ConstructNestedGeneric(
                        def,
                        enclosingArgs,
                        ownArgs,
                        $scope.References!!.MapClrTypeToReferences
                    )
                } else if !enclosingArgs.IsDefaultOrEmpty {
                    nestedType = StructSymbol.ConstructNested(
                        def,
                        enclosingArgs,
                        $scope.References!!.MapClrTypeToReferences
                    )
                } else if !ownArgs.IsDefaultOrEmpty {
                    nestedType = StructSymbol.Construct(def, ownArgs, $scope.References!!.MapClrTypeToReferences)
                } else {
                    nestedType = def
                }
                return true
            }
            case nestedIface is InterfaceSymbol {
                let ifaceDef = nestedIface.Definition ?? nestedIface
                nestedType = if !ownArgs.IsDefaultOrEmpty {
                    InterfaceSymbol.Construct(ifaceDef, ownArgs, $scope.References!!.MapClrTypeToReferences)
                } else {
                    ifaceDef
                }
                return true
            }
            default {
                nestedType = definitions[segments.Count - 1]
                return true
            }
        }
    }

    /// Issue #1537: flattens a user-type-naming expression into its ordered
    /// per-segment (simple name, bound own type-arguments) pairs. Because
    /// per-segment generics parse as an index over the preceding accessor
    /// (`Outer[int32].Middle[string]` is
    /// `((Outer[int32]).Middle)[string]`) and multi-argument segments parse
    /// as generic-name expressions, every shape (name, generic-name, index,
    /// accessor) is handled so arbitrary depth and arity flatten uniformly.
    /// @param expr The type-naming expression.
    /// @param segments The accumulator for resolved segments (outermost-first).
    /// @returns Whether the expression is a well-formed user-type name chain.
    private func TryFlattenUserTypeExpressionSegments(
        expr ExpressionSyntax,
        segments List[(Name string, Args ImmutableArray[TypeSymbol])]
    ) bool {
        // Issue #942 regression guard: flattening speculatively binds each
        // bracketed segment's contents as TYPE arguments. When the expression is
        // NOT a well-formed user-type name chain (e.g. a genuine indexer whose
        // index is a value), that speculative bind can report a type diagnostic
        // (GS0113) even though this probe ultimately returns false and the caller
        // falls back to normal binding. Snapshot the diagnostic bag and roll it
        // back on failure so the probe is side-effect-free for ANY chain shape.
        let diagMark = Diagnostics.Count
        if TryFlattenUserTypeExpressionSegmentsCore(expr, segments) {
            return true
        }
        Diagnostics.TruncateTo(diagMark)
        return false
    }

    /// Issue #1537: the recursive core of
    /// (cref:TryFlattenUserTypeExpressionSegments). The wrapper snapshots
    /// and rolls back the diagnostic bag around this method so a failed probe
    /// never leaks the speculative type-argument-binding diagnostics it emits.
    /// @param expr The type-naming expression.
    /// @param segments The accumulator for resolved segments (outermost-first).
    /// @returns Whether the expression is a well-formed user-type name chain.
    private func TryFlattenUserTypeExpressionSegmentsCore(
        expr ExpressionSyntax,
        segments List[(Name string, Args ImmutableArray[TypeSymbol])]
    ) bool {
        switch expr {
            case name is NameExpressionSyntax {
                segments.Add((name.IdentifierToken.ValueText, default(ImmutableArray[TypeSymbol])))
                return true
            }
            case generic is GenericNameExpressionSyntax {
                if !TryBindGenericSegmentArguments(generic, out var genericArgs) {
                    return false
                }
                segments.Add((generic.Identifier.ValueText, genericArgs))
                return true
            }
            case index is IndexExpressionSyntax when !index.IsNullConditional {
                if index.Target is NameExpressionSyntax indexTargetName {
                    if !TryBindTypeArgumentExpressions(index.Indices, out var rootArgs) {
                        return false
                    }
                    segments.Add((indexTargetName.IdentifierToken.ValueText, rootArgs))
                    return true
                }
                if !TryFlattenUserTypeExpressionSegments(index.Target, segments) || segments.Count == 0 {
                    return false
                }
                let last = segments[segments.Count - 1]
                if !last.Args.IsDefaultOrEmpty {
                    return false
                }
                if !TryBindTypeArgumentExpressions(index.Indices, out var lastArgs) {
                    return false
                }
                segments[segments.Count - 1] = (last.Name, lastArgs)
                return true
            }
            case accessor is AccessorExpressionSyntax when !accessor.IsNullConditional {
                if !TryFlattenUserTypeExpressionSegments(accessor.LeftPart, segments) {
                    return false
                }
                switch accessor.RightPart {
                    case rightName is NameExpressionSyntax {
                        segments.Add((rightName.IdentifierToken.ValueText, default(ImmutableArray[TypeSymbol])))
                        return true
                    }
                    case rightGeneric is GenericNameExpressionSyntax when TryBindGenericSegmentArguments(
                        rightGeneric,
                        out var rightArgs
                    ) {
                        segments.Add((rightGeneric.Identifier.ValueText, rightArgs))
                        return true
                    }
                    default {
                        return false
                    }
                }
            }
            default {
                return false
            }
        }
    }

    /// Issue #1537: binds the type-argument clauses of a generic-name segment
    /// (`Middle[string]`) to their type symbols for nested-type chain
    /// resolution in expression position.
    /// @param generic The generic-name segment.
    /// @param typeArgs The bound type arguments on success.
    /// @returns Whether all type-argument clauses bound successfully.
    private func TryBindGenericSegmentArguments(
        generic GenericNameExpressionSyntax,
        out typeArgs ImmutableArray[TypeSymbol]
    ) bool {
        typeArgs = default(ImmutableArray[TypeSymbol])
        let argClauses = generic.TypeArgumentList.Arguments
        let builder = ImmutableArray.CreateBuilder[TypeSymbol](argClauses.Count)
        for clause in argClauses {
            let bound TypeSymbol? = bindTypeClause(clause)
            if bound == nil {
                return false
            }
            builder.Add(bound)
        }
        typeArgs = builder.ToImmutable()
        return true
    }

    /// Issue #919: resolves a lowercase predefined primitive type alias used as
    /// the receiver of a static member access (e.g. `string.Empty`,
    /// `int32.MaxValue`, `object.ReferenceEquals(...)`) to an
    /// (cref:ImportedClassSymbol) over its underlying CLR type.
    /// @remarks This runs only after the import/alias/imported-class lookups have failed,
    /// so it never shadows a user alias or an imported type. The keyword aliases
    /// (`string`, `int32`, `bool`, ...) are reserved names that
    /// cannot be redeclared, so resolving them here is unambiguous and mirrors
    /// the capitalized CLR-name form (`String`, `Int32`) that already
    /// binds through (cref:BoundScope.TryLookupImportedClass(string, ExpressionSyntax, out
    /// ImportedClassSymbol)).
    /// @param name The identifier text written as the accessor receiver.
    /// @param declaration The receiver name syntax (for symbol provenance).
    /// @param classSymbol The resolved CLR class symbol on success.
    /// @returns `true` when [`name`](paramref) is a predefined primitive alias with a backing CLR type.
    private func TryResolvePredefinedTypeReceiver(
        name string,
        declaration ExpressionSyntax,
        @NotNullWhen(true) out classSymbol ImportedClassSymbol?
    ) bool {
        classSymbol = nil
        let typeSymbol TypeSymbol? = lookupType(name)
        // Only genuine predefined primitive aliases carry a non-null ClrType and
        // are not already handled by an earlier branch. User struct/enum aliases
        // (resolved by TryLookupTypeAlias) have a null ClrType and are excluded.
        // `void` has a CLR type but is meaningless as a static-access receiver, so
        // exclude it and let the normal "cannot find type" diagnostic apply.
        if typeSymbol == nil || typeSymbol.ClrType is not Type predefinedClrType || object.ReferenceEquals(
            typeSymbol,
            TypeSymbol.Void
        ) {
            return false
        }
        // Primitive symbols hold host-runtime CLR types. Project the receiver
        // into the active reference context so its overload parameter types
        // share identity with imported argument types under SDK compilation,
        // and so only the target framework's members are candidates (#4924;
        // the same decision as the instance-receiver lookups).
        if !$scope.References!!.TryGetMemberLookupType(predefinedClrType, out var receiverType) {
            return false
        }
        classSymbol = ImportedClassSymbol(receiverType, declaration, references: $scope.References)
        return true
    }

    private func BindNullConditionalAccessExpression(syntax AccessorExpressionSyntax) BoundExpression {
        let receiver = BindExpression(syntax.LeftPart)
        if receiver is BoundErrorExpression {
            return receiver
        }
        return BindNullConditionalAccessExpressionCore(receiver, syntax.RightPart)
    }

    private func BindNullConditionalAccessExpressionCore(
        receiver BoundExpression,
        rightPart ExpressionSyntax
    ) BoundExpression {
        if rightPart is UnaryExpressionSyntax unary && unary.OperatorToken.Kind == SyntaxKind.BangBangToken {
            let liftedOperand = BindNullConditionalAccessExpressionCore(receiver, unary.Operand)
            if liftedOperand is BoundErrorExpression {
                return liftedOperand
            }
            ReportNullAssertionIfRedundant(unary.OperatorToken, liftedOperand)
            let assertionOperator BoundUnaryOperator? = BoundUnaryOperator.Bind(
                unary.OperatorToken.Kind,
                liftedOperand.Type
            )
            if assertionOperator == nil {
                Diagnostics.ReportUndefinedUnaryOperator(
                    unary.OperatorToken.Location,
                    unary.OperatorToken.Text,
                    liftedOperand.Type
                )
                return BoundErrorExpression(nil)
            }
            return BoundUnaryExpression(nil, assertionOperator, liftedOperand, binderCtx.IsCheckedContext)
        }
        let receiverType = receiver.Type
        var underlying TypeSymbol
        if receiverType is NullableTypeSymbol nullable {
            underlying = nullable.UnderlyingType
        } else if receiverType is PlatformTypeSymbol platform {
            // ADR-0186 §6: `?.` accepts a `T!` receiver and yields `U?` as
            // usual. This is also §4's "no check" case: the access is guarded
            // by the `?.` itself, so no coercion to a non-null destination
            // ever occurs — the capture is bound at the underlying `T` only
            // on the branch where the value is already known non-nil.
            underlying = platform.UnderlyingType
        } else if receiverType == TypeSymbol.Null {
            // `nil?.x` is statically nil.
            return BoundLiteralExpression(nil, nil)
        } else {
            // Non-nullable receiver: `?.` collapses to `.`, but we still
            // produce a nullable result type for syntactic consistency.
            underlying = receiverType
        }
        // Create a synthetic capture local. Name is not user-visible; we
        // include a leading `$` so it cannot collide with user identifiers.
        let captureName = "$$ncap_" + (binderCtx.NullConditionalCaptureCounter += 1).ToString(
            CultureInfo.InvariantCulture
        )
        let capture = LocalVariableSymbol(captureName, isReadOnly: true, type: underlying)
        // Bind the access using the capture as the receiver. We push a temp
        // scope so the capture is in scope for any nested name lookup that
        // happens during access binding (defensive — current accessor paths
        // don't look up the receiver by name).
        $scope = BoundScope($scope)
        $scope.TryDeclareVariable(capture)
        let captureRef = BoundVariableExpression(nil, capture)
        let whenNotNull = BindAccessorStep(captureRef, nil, rightPart)
        // Issue #3978: the temp scope above exists only to hold the synthetic
        // capture, but binding the right part can DECLARE user-visible names
        // in it — an inline `out var` argument is the one that matters:
        //
        //     if map?.TryGetValue(key, out var found) == true { use(found) }
        //
        // An `out var` binds in the scope enclosing the call, exactly as it
        // does when the receiver is spelled `map!!.`. Popping this scope
        // wholesale discarded those declarations, so every later reference
        // reported GS0125 "Variable 'found' doesn't exist": a `?.` receiver
        // silently changed where an `out var` landed. Promote whatever the
        // right part declared — everything except the capture itself, which is
        // synthetic and must stay invisible — into the enclosing scope.
        //
        // Spelled without `?.` and without a discarded call result on purpose:
        // this file is inside the self-migration corpus, and the defect being
        // fixed here is precisely a construct that C# accepted and the
        // migrated G# did not.
        let enclosingScope BoundScope? = $scope.Parent
        if enclosingScope != nil {
            for declared in $scope.GetDeclaredVariables() {
                if !object.ReferenceEquals(declared, capture) {
                    // A name already declared in the enclosing scope loses the
                    // race and keeps its existing binding, which is the same
                    // shadowing outcome the non-`?.` spelling produces.
                    enclosingScope.TryDeclareVariable(declared)
                }
            }
        }
        $scope = $scope.Pop()
        // Issue #1213: a null-conditional invocation whose access produces no
        // value — the canonical event-raise form `evt?.Invoke(args)` where the
        // delegate returns `void` — is itself a `void` statement. Do not wrap
        // `void` in a nullable result type; that would force the emitter to
        // push a `null` on the nil branch with nothing to match it on the
        // not-null branch (a stack-imbalance). The emitter special-cases a
        // `void`-typed null-conditional to a plain null-guarded call.
        if object.ReferenceEquals(whenNotNull.Type, TypeSymbol.Void) {
            return BoundNullConditionalAccessExpression(
                nil,
                receiver,
                capture,
                whenNotNull,
                TypeSymbol.Void,
                resultSlot: nil
            )
        }
        let resultType = if whenNotNull.Type is NullableTypeSymbol {
            whenNotNull.Type
        } else {
            cast[TypeSymbol](NullableTypeSymbol.Get(whenNotNull.Type))
        }
        // P2-7 / Issue #421: when the access result is a value type, the
        // bound result type is `Nullable<T>` but the not-null branch pushes
        // a raw `T` and the nil branch would push `null`. The emitter needs
        // a typed temp slot to materialize `default(Nullable<T>)` for the
        // nil branch (initobj) and to host the wrapped value for the
        // not-null branch (newobj `Nullable<T>::.ctor(!0)`). We allocate
        // that synthetic slot here so the emit pre-pass can give it a
        // local index alongside the capture local.
        //
        // ADR-0073 / issue #710: chained `?.`/`?[]` can yield a
        // `WhenNotNull` that is itself already a `Nullable<T>`. In that
        // case both branches still need to leave a Nullable<T> on the
        // stack, so we MUST allocate the slot whenever the *result type's
        // underlying* is a value type — even if `whenNotNull.Type` is
        // already nullable. The emitter inspects `WhenNotNull.Type` to
        // decide whether to wrap with `newobj` or pass through.
        //
        // Issue #1475: the slot must be allocated for ANY value-type
        // underlying recognised by SYMBOL — user `EnumSymbol`, value-type
        // `StructSymbol`, a value-constrained type parameter, tuple — not only
        // when the underlying carries a runtime `ClrType.IsValueType`. User
        // enums/structs have a null `ClrType`, so the old gate skipped them and
        // emit fell to the reference (`ldnull`) branch, producing unverifiable
        // IL (`StackUnexpected`/`PathStackUnexpected`). Routing through the
        // canonical symbol-level value-type predicate keeps BCL behaviour
        // identical while covering user value types.
        var resultSlot LocalVariableSymbol? = nil
        if resultType is NullableTypeSymbol nullableResult && ReflectionMetadataEmitter.IsValueTypeSymbol(
            nullableResult.UnderlyingType
        ) {
            let resultSlotName = "$$nres_" + binderCtx.NullConditionalCaptureCounter.ToString(
                CultureInfo.InvariantCulture
            )
            resultSlot = LocalVariableSymbol(resultSlotName, isReadOnly: false, type: resultType)
        }
        return BoundNullConditionalAccessExpression(nil, receiver, capture, whenNotNull, resultType, resultSlot)
    }

    private func TryBindImportAccessor(
        $import ImportSymbol,
        ref rightPart ExpressionSyntax,
        @NotNullWhen(true) out importedClass ImportedClassSymbol?
    ) bool {
        // Handle `<importName>.<Segment>(.<Segment>)*.<TypeName>(.<more>)*` where
        // <importName> is either an alias or the import's path. Walks the accessor
        // chain extending the namespace prefix until a segment resolves as a type;
        // unresolved leading segments are treated as additional namespace levels
        // (issue #687: e.g. `System.IO.Path.Combine(...)` with `import System.IO`
        // peels `IO` as a namespace continuation, then resolves `System.IO.Path`).
        importedClass = nil
        let currentPath = $import.Target
        // A type alias (`import R = System.Console`) names a type outright: the
        // import target itself resolves as a type, and the accessor's right part
        // is a *static member* of it (`R.WriteLine`, `R.EncryptedFileExt`) rather
        // than a further namespace/type segment. Resolve the target as a type
        // first and leave the right part unconsumed so the caller binds it as the
        // member access on the aliased type. (A plain namespace import target does
        // not resolve as a type, so the segment-walk below still owns that case.)
        if $scope.References!!.TryResolveType(currentPath, out var aliasTargetType) {
            importedClass = ImportedClassSymbol(aliasTargetType!!, rightPart, references: $scope.References)
            return true
        }
        return TryWalkQualifiedClrTypePath(currentPath, &rightPart, out importedClass)
    }

    /// Issue #2258: last-resort fallback for a fully-qualified CLR type reference
    /// written in expression position whose leading segment is NOT a registered
    /// import/alias — e.g. `Microsoft.Extensions.Logging.LogLevel.Warning`
    /// (CLR enum member) or
    /// `Microsoft.Extensions.Logging.Abstractions.NullLoggerFactory.Instance`
    /// (CLR static field). cs2gs fully-qualifies every type reference, so a
    /// referenced-assembly type accessed by its full namespace path lands here
    /// when the root namespace segment (`Microsoft`) matches no import.
    /// Walks the dotted chain the same way (cref:TryBindImportAccessor)
    /// does, but starting from the bare leading name as the first namespace
    /// segment, so any referenced CLR type — regardless of namespace depth —
    /// resolves and its trailing member binds as a static access.
    private func TryBindFullyQualifiedClrStaticAccess(
        leftName NameExpressionSyntax,
        ref rightPart ExpressionSyntax,
        @NotNullWhen(true) out importedClass ImportedClassSymbol?
    ) bool -> TryWalkQualifiedClrTypePath(leftName.IdentifierToken.ValueText, &rightPart, out importedClass)

    private func TryBindFullyQualifiedClrStaticAccess(
        leftName NameExpressionSyntax,
        ref rightPart ExpressionSyntax,
        @NotNullWhen(true) out importedClass ImportedClassSymbol?,
        out missingType SyntaxToken?,
        out resolvedPrefix string?,
        out resolvedPrefixIsPackage bool,
        out failureHandled bool,
        out invalidGenericType SyntaxToken?,
        out invalidTypeArgument ExpressionSyntax?
    ) bool -> TryWalkQualifiedClrTypePath(
        leftName.IdentifierToken.ValueText,
        &rightPart,
        out importedClass,
        out missingType,
        out resolvedPrefix,
        out resolvedPrefixIsPackage,
        out failureHandled,
        out invalidGenericType,
        out invalidTypeArgument
    )

    /// Walks a dotted accessor chain, extending a namespace prefix segment by
    /// segment until a prefix resolves to a referenced CLR type. On success the
    /// resolved type is returned as an (cref:ImportedClassSymbol) and
    /// [`rightPart`](paramref) is advanced to the remaining (post-type)
    /// member-access chain. Shared by (cref:TryBindImportAccessor) (which
    /// starts from a registered import target) and
    /// `TryBindFullyQualifiedClrStaticAccess` (which starts from a
    /// bare leading namespace name).
    private func TryWalkQualifiedClrTypePath(
        startPath string,
        ref rightPart ExpressionSyntax,
        @NotNullWhen(true) out importedClass ImportedClassSymbol?
    ) bool -> TryWalkQualifiedClrTypePath(
        startPath,
        &rightPart,
        out importedClass,
        out _,
        out _,
        out _,
        out _,
        out _,
        out _
    )

    private func TryWalkQualifiedClrTypePath(
        startPath string,
        ref rightPart ExpressionSyntax,
        @NotNullWhen(true) out importedClass ImportedClassSymbol?,
        out missingType SyntaxToken?,
        out resolvedPrefix string?,
        out resolvedPrefixIsPackage bool,
        out failureHandled bool,
        out invalidGenericType SyntaxToken?,
        out invalidTypeArgument ExpressionSyntax?
    ) bool {
        importedClass = nil
        missingType = nil
        resolvedPrefix = nil
        resolvedPrefixIsPackage = false
        failureHandled = false
        invalidGenericType = nil
        invalidTypeArgument = nil
        var currentPath = startPath
        var currentRight = rightPart
        while true {
            // Issue #2209: `Ns.Sub.Generic[Args].StaticMember` places a generic
            // instantiation (`Comparer[int32]`, parsed as an `IndexExpressionSyntax`
            // for a single type argument or a `GenericNameExpressionSyntax` for
            // multiple/type-shaped arguments) in the middle of the dotted chain,
            // immediately followed by the static member access. Neither shape is
            // a plain `NameExpressionSyntax` segment, so without this case the
            // walk below falls through to `default: return false` at the FIRST
            // segment, and the caller re-reports the whole chain as an undefined
            // type starting from its leftmost name. Close the generic type here
            // (mirroring the non-generic branch just below) and hand the
            // remaining chain back as the static-member access on the closed type.
            if currentRight is AccessorExpressionSyntax genericSegment &&
                TryGetGenericSegmentNameAndArity(
                genericSegment.LeftPart,
                out var genericIdentifier,
                out var genericArity
            ) {
                let mangledName = currentPath + "." + genericIdentifier!!.ValueText + "`" + genericArity.ToString()
                if $scope.References!!.TryResolveType(mangledName, out var openGenericType) {
                    let diagnosticCount = Diagnostics.Count
                    if !TryBindGenericImportSegmentTypeArguments(
                        genericSegment.LeftPart,
                        genericArity,
                        out var segmentTypeArgs
                    ) {
                        if Diagnostics.Count > diagnosticCount {
                            failureHandled = true
                        } else {
                            invalidTypeArgument = if genericSegment.LeftPart is IndexExpressionSyntax index {
                                index.Indices.FirstOrDefault(
                                    (argument ExpressionSyntax) -> !TryBuildTypeClauseFromExpression(argument, out _)
                                )
                            } else {
                                genericSegment.LeftPart
                            }
                            invalidTypeArgument ??= genericSegment.LeftPart
                        }
                        return false
                    }
                    let closeDiagnosticCount = Diagnostics.Count
                    if TryCloseImportedGenericTypeReceiver(
                        openGenericType!!,
                        segmentTypeArgs,
                        genericSegment.LeftPart,
                        out var closedGenericImported
                    ) {
                        importedClass = closedGenericImported
                        rightPart = genericSegment.RightPart
                        return true
                    }
                    // Issue #4032: the close can now fail for a reason it has
                    // already EXPLAINED — a type argument that does not satisfy
                    // the open definition's declared constraint (GS0152). The
                    // `invalidGenericType` fallback below exists for the
                    // unexplained case, and its message is "Type 'X' is not
                    // generic" — which for `System.Nullable[string]` is simply
                    // false: `Nullable`1` IS generic, the argument is wrong.
                    // Follow the same convention the type-argument branch above
                    // already uses (snapshot the bag, and treat growth as
                    // "handled") so the accurate diagnostic stands alone.
                    if Diagnostics.Count > closeDiagnosticCount {
                        failureHandled = true
                        return false
                    }
                    if !$scope.TryLookupSourceTypeInPackage(
                        currentPath,
                        genericIdentifier!!.ValueText,
                        genericArity,
                        out _
                    ) {
                        invalidGenericType = genericIdentifier
                    }
                    return false
                }
                if $scope.References!!.TryResolveType(currentPath + "." + genericIdentifier!!.ValueText, out _) ||
                    $scope
                    .TryLookupSourceTypeInPackage(
                    currentPath,
                    genericIdentifier!!.ValueText,
                    preferredArity: 0,
                    out _
                ) {
                    invalidGenericType = genericIdentifier
                    return false
                }
                // A generic instantiation can never be a further namespace
                // level, so a failed resolution here ends the walk instead of
                // falling through to the plain-segment cases below.
                if TryClassifyQualifiedNamespaceOrPackage(currentPath, out resolvedPrefixIsPackage) {
                    missingType = genericIdentifier
                    resolvedPrefix = currentPath
                }
                return false
            }
            var typeNameSyntax NameExpressionSyntax
            var remainder ExpressionSyntax
            var hasMoreChain bool
            switch currentRight {
                case nested is AccessorExpressionSyntax {
                    if nested.LeftPart is not NameExpressionSyntax leftName {
                        return false
                    }
                    typeNameSyntax = leftName
                    remainder = nested.RightPart
                    hasMoreChain = true
                }
                case ne is NameExpressionSyntax {
                    typeNameSyntax = ne
                    remainder = ne
                    hasMoreChain = false
                }
                case call is CallExpressionSyntax when !call.Identifier.IsMissing {
                    if TryClassifyQualifiedNamespaceOrPackage(currentPath, out resolvedPrefixIsPackage) {
                        missingType = call.Identifier
                        resolvedPrefix = currentPath
                    }
                    return false
                }
                default {
                    return false
                }
            }
            let fullTypeName = currentPath + "." + typeNameSyntax.IdentifierToken.ValueText
            if $scope.References!!.TryResolveType(fullTypeName, out var type) {
                importedClass = ImportedClassSymbol(type!!, typeNameSyntax, references: $scope.References)
                rightPart = remainder
                return true
            }
            // Not a type. If there's still a chain to consume, treat this segment
            // as another namespace level and keep walking. Otherwise, give up.
            if !hasMoreChain {
                if TryClassifyQualifiedNamespaceOrPackage(currentPath, out resolvedPrefixIsPackage) {
                    missingType = typeNameSyntax.IdentifierToken
                    resolvedPrefix = currentPath
                }
                return false
            }
            if TryClassifyQualifiedNamespaceOrPackage(fullTypeName, out _) {
                currentPath = fullTypeName
                currentRight = remainder
                continue
            }
            if TryClassifyQualifiedNamespaceOrPackage(currentPath, out resolvedPrefixIsPackage) {
                missingType = typeNameSyntax.IdentifierToken
                resolvedPrefix = currentPath
                return false
            }
            currentPath = fullTypeName
            currentRight = remainder
        }
    }

    private func TryClassifyQualifiedNamespaceOrPackage(prefix string, out isPackage bool) bool {
        if $scope.TryMatchSourcePackagePrefix(prefix, out var exactPackage) {
            isPackage = exactPackage
            return true
        }
        if $scope.References!!.ContainsNamespace(prefix) {
            isPackage = false
            return true
        }
        isPackage = false
        return false
    }

    /// Issue #2209: binds the type-argument(s) of a generic-instantiation
    /// segment recognised by (cref:TryGetGenericSegmentNameAndArity),
    /// dispatching to the matching argument shape (index-expression argument or
    /// generic-name type-argument list).
    private func TryBindGenericImportSegmentTypeArguments(
        segment ExpressionSyntax,
        arity int32,
        out typeArgs ImmutableArray[TypeSymbol]
    ) bool {
        switch segment {
            case index is IndexExpressionSyntax {
                return TryBindTypeArgumentExpressions(index.Indices, out typeArgs) && typeArgs.Length == arity
            }
            case generic is GenericNameExpressionSyntax {
                return TryBindGenericSegmentArguments(generic, out typeArgs) && typeArgs.Length == arity
            }
            case CallExpressionSyntax{TypeArgumentList: not nil} call {
                return TryResolveClrConstructionTypeArgs(call.TypeArgumentList!!, out _, out typeArgs, out _) &&
                    typeArgs.Length == arity
            }
            default {
                typeArgs = default(ImmutableArray[TypeSymbol])
                return false
            }
        }
    }

    /// Issue #687 (Option A): when a name resolves to a value but also matches an
    /// in-scope type with the same simple name (an imported/aliased CLR type,
    /// user-defined struct/class, or enum), surface that type so the caller can
    /// apply the C#-style "color color" preference when the right-hand side of
    /// the accessor is a static member of the type.
    private func TryResolveColorColorType(
        name string,
        leftName NameExpressionSyntax?,
        out importedClassSymbol ImportedClassSymbol?,
        out userStructSymbol StructSymbol?,
        out interfaceSymbol InterfaceSymbol?,
        out enumSymbol EnumSymbol?
    ) bool {
        importedClassSymbol = nil
        userStructSymbol = nil
        interfaceSymbol = nil
        enumSymbol = nil
        if binderCtx.TryLookupSourceType(
            $scope,
            name,
            preferredArity: 0,
            getCurrentFunction(),
            out var typeAlias,
            out _
        ) {
            if TryResolveImportedTypeOverride(
                name,
                typeAlias!!,
                requestedArity: 0,
                leftName,
                out var importedOverride
            ) {
                importedClassSymbol = importedOverride
                return true
            }
            if typeAlias is StructSymbol foundStruct {
                userStructSymbol = foundStruct
                return true
            }
            if typeAlias is EnumSymbol foundEnum {
                enumSymbol = foundEnum
                return true
            }
            if typeAlias is InterfaceSymbol foundInterface {
                interfaceSymbol = foundInterface
                return true
            }
        }
        let clrType = lookupType(name)
        if clrType?.ClrType != nil && !object.ReferenceEquals(clrType, TypeSymbol.Void) {
            importedClassSymbol = ImportedClassSymbol(clrType!!.ClrType!!, leftName, references: $scope.References)
            return true
        }
        if $scope.TryLookupImportedClass(name, leftName, out var importedClass, out var ambiguity) {
            // Issue #3734: see BindStaticAccessorStep — report the collision at
            // the receiver, keep the first-import-wins answer.
            if ambiguity != nil && leftName != nil {
                Diagnostics.ReportAmbiguousImportedTypeReference(leftName.Location, name, ambiguity)
            }
            importedClassSymbol = importedClass
            return true
        }
        return false
    }

    /// Applies the shared lexical source/import precedence for a simple type receiver.
    private func TryResolveImportedTypeOverride(
        name string,
        sourceType TypeSymbol,
        requestedArity int32,
        declaration ExpressionSyntax?,
        @NotNullWhen(true) out importedType ImportedClassSymbol?
    ) bool {
        if $scope.TryLookupImportedClassByArity(name, requestedArity, declaration, out var candidate) &&
            binderCtx
            .ImportedTypeOverridesSourceType(
            $scope,
            name,
            sourceType,
            requestedArity,
            getCurrentFunction(),
            candidate!!.ClassType
        ) {
            importedType = candidate
            return true
        }
        importedType = nil
        return false
    }

    /// Resolves a source type only when it remains visible after applying the
    /// same lexical-inside / explicit-import-outside precedence as ordinary
    /// type receivers.
    private func TryLookupSourceTypeWithImportPrecedence(
        name string,
        preferredArity int32,
        declaration ExpressionSyntax?,
        @NotNullWhen(true) out sourceType TypeSymbol?
    ) bool {
        if !binderCtx.TryLookupSourceType($scope, name, preferredArity, getCurrentFunction(), out sourceType, out _) ||
            TryResolveImportedTypeOverride(name, sourceType!!, preferredArity, declaration, out _) {
            sourceType = nil
            return false
        }
        return true
    }

    /// Issue #1147 (Facet A): finalizes a "Color Color" member-access CALL whose
    /// receiver name binds to BOTH a value (an in-scope property/field/local/
    /// parameter) and a same-named user struct/class ([`structSym`](paramref)),
    /// when the invoked method name is declared as BOTH an instance and a static
    /// (`shared`) overload. The call is resolved against the unified
    /// instance + static overload set and routed by the selected method's
    /// (cref:FunctionSymbol.IsStatic):
    /// - instance overload → the value is bound as the receiver and the call is dispatched as an ordinary
    /// instance call;
    /// - static overload → the call is bound as a static member call on the type.
    /// Returns `false` (leaving [`result`](paramref) unset)
    /// when the method name is not declared in BOTH buckets, so the existing #687
    /// type path (static-only) and the value/instance path (instance-only) keep
    /// their current behavior unchanged.
    private func TryBindColorColorUnifiedCall(
        structSym StructSymbol,
        leftName NameExpressionSyntax,
        ce CallExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let methodName = ce.Identifier.ValueText
        let instanceGroup = TypeMemberModel.GetMethods(structSym, methodName, MemberQuery.Instance(MemberKinds.Method))
        let staticGroup = TypeMemberModel.GetMethods(structSym, methodName, MemberQuery.Static(MemberKinds.Method))
        // Only intercept the genuinely-ambiguous case: the name is declared as
        // BOTH an instance and a static overload. Otherwise defer to the existing
        // paths so behavior is unchanged.
        if instanceGroup.IsDefaultOrEmpty || staticGroup.IsDefaultOrEmpty {
            return false
        }
        if !overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames) {
            result = BoundErrorExpression(nil)
            return true
        }
        let boundArguments = ImmutableArray.CreateBuilder[BoundExpression](ce.Arguments.Count)
        for argument in ce.Arguments {
            let argSyntax = OverloadResolver.UnwrapNamedArgumentValue(argument)
            boundArguments.Add(
                if argSyntax is RefArgumentExpressionSyntax refArg {
                    BindRefArgumentExpression(refArg, parameter: nil)
                } else {
                    BindArgumentDeferringBranchy(argSyntax)
                }
            )
        }
        let arguments = boundArguments.ToImmutable()
        let unified = instanceGroup.AddRange(staticGroup)
        let method FunctionSymbol? = overloads.SelectInstanceOverloadOrReport(
            unified,
            arguments,
            ce,
            methodName,
            argumentNames
        )
        if method == nil {
            result = BoundErrorExpression(nil)
            return true
        }
        if method.IsStatic {
            // Static overload selected: bind as a static member call on the type
            // (re-resolves the static group, applying optional/variadic/generic
            // fidelity through the shared static-call finalizer).
            result = BindUserTypeStaticCall(structSym, ce)
            return true
        }
        // Instance overload selected: materialize the value (property / field /
        // local / parameter) as the receiver and dispatch the instance call with
        // the already-bound arguments.
        let receiver = BindNameExpression(leftName)
        if receiver is BoundErrorExpression {
            result = receiver
            return true
        }
        result = overloads.BindUserInstanceCall(receiver, method, arguments, ce, argumentNames)
        return true
    }

    /// Issue #687 (Option A): inspects the right-hand side of an accessor chain
    /// to determine whether it would bind as a static member (field, property,
    /// event, nested type, or method) of the supplied type. Used to decide
    /// between the value and type interpretation when a name collides with a
    /// same-named type in scope. When no static member matches, the binder
    /// falls back to the value interpretation so existing instance-access
    /// semantics continue to work unchanged.
    private func RightPartLooksLikeStaticMember(
        importedClassSymbol ImportedClassSymbol?,
        userStructSymbol StructSymbol?,
        interfaceSymbol InterfaceSymbol?,
        enumSymbol EnumSymbol?,
        rightPart ExpressionSyntax
    ) bool {
        if !TryGetAccessorChainHead(rightPart, out var headName, out var isCall) {
            return false
        }
        if importedClassSymbol != nil {
            return HasStaticMember(importedClassSymbol.ClassType, headName, isCall)
        }
        if userStructSymbol != nil {
            return HasUserTypeStaticMember(userStructSymbol, headName, isCall)
        }
        if interfaceSymbol != nil {
            return HasUserTypeStaticMember(interfaceSymbol, headName, isCall)
        }
        if enumSymbol != nil {
            return !isCall && enumSymbol.TryGetMember(headName, out _)
        }
        return false
    }

    private func HasStaticMember(clrType Type?, headName string, isCall bool) bool {
        if clrType == nil {
            return false
        }
        if isCall {
            let methods = ClrTypeUtilities.SafeGetMethodsIncludingInterfaces(
                clrType,
                BindingFlags.Public | BindingFlags.Static
            )
            for m in methods {
                if m.Name == headName {
                    return true
                }
            }
            if $scope.References!!.TryResolveNestedType(clrType, headName, out _) {
                return true
            }
            return false
        }
        if ClrTypeUtilities.SafeGetField(clrType, headName, BindingFlags.Public | BindingFlags.Static) != nil {
            return true
        }
        let prop PropertyInfo? = ClrTypeUtilities.SafeGetProperty(
            clrType,
            headName,
            BindingFlags.Public | BindingFlags.Static
        )
        if prop != nil && prop.GetIndexParameters().Length == 0 {
            return true
        }
        if $scope.References!!.TryResolveNestedType(clrType, headName, out _) {
            return true
        }
        try {
            if clrType.GetEvent(headName, BindingFlags.Public | BindingFlags.Static) != nil {
                return true
            }
        } catch (Exception) {
            // Defensive: some metadata-load-context types throw on event lookup;
            // treat as "no event" so the binder falls back to instance semantics.

        }
        return false
    }

    private func BindEnumAccessorStep(enumSymbol EnumSymbol, rightPart ExpressionSyntax) BoundExpression {
        switch rightPart {
            case nested is AccessorExpressionSyntax {
                let head = BindEnumAccessorStep(enumSymbol, nested.LeftPart)
                if head is BoundErrorExpression {
                    return head
                }
                return BindAccessorStep(head, nil, nested.RightPart)
            }
            case ne is NameExpressionSyntax {
                let memberName = ne.IdentifierToken.ValueText
                if enumSymbol.TryGetMember(memberName, out var member) {
                    // Issue #188 / #175: every read of an `@Obsolete` enum
                    // member surfaces GS0204 at the member-identifier
                    // location (e.g. `Color.Red`).
                    reportObsoleteUseIfApplicable(ne.Location, member!!, "${enumSymbol.Name}.${member!!.Name}")
                    let literal = BoundLiteralExpression(nil, member!!.Value, enumSymbol)
                    literal.RecordStaticEnumQualifier(enumSymbol, ne, member!!)
                    return literal
                }
                Diagnostics.ReportUndefinedEnumMember(ne.Location, memberName, enumSymbol.Name)
                return BoundErrorExpression(nil)
            }
            default {
                return BoundErrorExpression(nil)
            }
        }
    }

    /// Resolves user struct/class static members (ADR-0053) and nested
    /// construction under the actual enclosing receiver.
    private func BindUserTypeStaticAccessorStep(structSym StructSymbol, rightPart ExpressionSyntax) BoundExpression {
        let result = BindUserTypeStaticAccessorStepCore(structSym, rightPart)
        RecordStaticTypeQualifier(result, structSym, rightPart)
        return result
    }

    private func BindUserTypeStaticAccessorStepCore(
        structSym StructSymbol,
        rightPart ExpressionSyntax
    ) BoundExpression {
        switch rightPart {
            case nested is AccessorExpressionSyntax {
                // Issue #1537: the left portion may name a nested TYPE of the
                // constructed receiver (`Middle[string]` under `Outer[int32]`),
                // with the rightPart a composite literal / member / call on that
                // nested type — i.e. a per-segment generic chain of depth ≥ 3
                // (`Outer[int32].Middle[string].Inner{…}`) parses right-leaning
                // so the inner segments arrive here rather than at the top-level
                // accessor. Resolve the nested-type chain under the receiver
                // (threading the flattened enclosing arguments) and bind the
                // tail against it. Falls through to the value/static-member path
                // when the left portion is not a nested type.
                if TryResolveNestedTypeChainUnderReceiver(
                    structSym,
                    nested.LeftPart,
                    out var innerStruct,
                    out var innerEnum
                ) {
                    if innerEnum != nil {
                        return BindEnumAccessorStep(innerEnum, nested.RightPart)
                    }
                    return if innerStruct != nil {
                        BindUserTypeStaticAccessorStep(innerStruct, nested.RightPart)
                    } else {
                        cast[BoundExpression](BoundErrorExpression(nil))
                    }
                }
                let importedBaseType = TypeMemberModel.GetNearestImportedBase(structSym)
                if importedBaseType?.ClrType is Type importedBase {
                    let importedBaseSymbol = CreateInheritedImportedClassSymbol(importedBaseType!!, nested.LeftPart)
                    if TryResolveNestedTypeFromAccessorLeft(
                        importedBaseSymbol,
                        nested.LeftPart,
                        out var importedNested
                    ) {
                        importedNested = CloseImportedNestedType(
                            importedBase,
                            importedNested!!,
                            nested.LeftPart,
                            importedBaseSymbol.SymbolicReceiver,
                            importedBaseSymbol.ConstructedReceiver
                        )
                        return BindAccessorStep(receiver: nil, importedNested, nested.RightPart)
                    }
                }
                let head = BindUserTypeStaticAccessorStep(structSym, nested.LeftPart)
                if head is BoundErrorExpression {
                    return head
                }
                if nested.IsNullConditional {
                    return BindNullConditionalAccessExpressionCore(head, nested.RightPart)
                }
                return BindAccessorStep(head, nil, nested.RightPart)
            }
            case ce is CallExpressionSyntax {
                // Resolve the nested owner before treating the name as a shared
                // method. Leave its own arguments to the constructor binder so
                // explicit arguments and inference retain the enclosing vector.
                if TryResolveNestedTypeChainUnderReceiver(
                    structSym,
                    NameExpressionSyntax(ce.SyntaxTree, ce.Identifier),
                    out var nestedConstructorType,
                    out var nestedConversionType,
                    ce.TypeArgumentList?.Arguments.Count ?? -1
                ) {
                    if nestedConstructorType != nil {
                        return overloads.BindConstructorCallExpression(ce, nestedConstructorType)
                    }
                    // Enums use the same explicit conversion as an unqualified
                    // T(value), retaining the resolved owner rather than a homonym.
                    if nestedConversionType != nil {
                        if ce.TypeArgumentList != nil {
                            Diagnostics.ReportWrongTypeArgumentCount(
                                ce.TypeArgumentList.Location,
                                nestedConversionType.Name,
                                0,
                                ce.TypeArgumentList.Arguments.Count
                            )
                            return BoundErrorExpression(ce)
                        }
                        if ce.Arguments.Count != 1 {
                            Diagnostics.ReportWrongArgumentCount(
                                ce.Location,
                                nestedConversionType.Name,
                                1,
                                ce.Arguments.Count
                            )
                            return BoundErrorExpression(ce)
                        }
                        let conversionTarget TypeSymbol = if ce.NullableQuestionToken != nil {
                            cast[TypeSymbol](NullableTypeSymbol.Get(nestedConversionType))
                        } else {
                            cast[TypeSymbol](nestedConversionType)
                        }
                        reportObsoleteUseIfApplicable(ce.Identifier.Location, conversionTarget, conversionTarget.Name)
                        return conversions.BindConversion(ce.Arguments[0], conversionTarget, allowExplicit: true)
                    }
                }
                return BindUserTypeStaticCall(structSym, ce)
            }
            case ObjectCreationExpressionSyntax{Target: {} target} creation {
                return BindObjectInitializerSuffix(creation, BindUserTypeStaticAccessorStep(structSym, target))
            }
            case CollectionInitializerExpressionSyntax{Target: {} target} collection {
                return BindCollectionInitializerSuffix(collection, BindUserTypeStaticAccessorStep(structSym, target))
            }
            case structLiteral is StructLiteralExpressionSyntax {
                return BindQualifiedNestedStructLiteral(structSym, structLiteral)
            }
            case ne is NameExpressionSyntax {
                return BindUserTypeStaticMemberAccess(structSym, ne)
            }
            case ix is IndexExpressionSyntax {
                let indexTarget = BindUserTypeStaticAccessorStep(structSym, ix.Target)
                if indexTarget is BoundErrorExpression {
                    return indexTarget
                }
                if ix.IsNullConditional {
                    return BindNullConditionalIndexFromBoundTarget(indexTarget, ix)
                }
                return if ix.Indices.Count > 1 || IsRectangularArrayType(indexTarget.Type) {
                    BindRectangularIndexAgainstTarget(indexTarget, ix.Indices, ix.Target.Location)
                } else {
                    BindIndexAgainstTarget(indexTarget, ix.Index, ix.Target.Location)
                }
            }
            default {
                return BoundErrorExpression(nil)
            }
        }
    }

    /// Issue #1537: binds a composite literal naming a type nested inside a
    /// CONSTRUCTED generic enclosing type
    /// (`Outer[int32].Middle[string]{…}`, `Box[int32].Tag{…}`). The
    /// nested type is resolved under [`outerConstructed`](paramref)'s
    /// definition, and the enclosing construction's flattened type arguments
    /// (its own enclosing arguments followed by its own arguments, outermost
    /// first — aligned with (cref:StructSymbol.CollectEnclosingTypeParameters(TypeSymbol)))
    /// are threaded onto the constructed nested symbol so member types
    /// substitute the enclosing parameters and the emitter encodes the reified
    /// nested type. Generalizes to arbitrary depth: at each level the outer
    /// segment already carries the flattened arguments of everything above it.
    /// @param outerConstructed The constructed generic enclosing segment (e.g. `Outer[int32]`).
    /// @param structLiteral The nested composite literal (e.g. `Middle[string]{…}`).
    /// @returns The bound nested struct literal, or a bound error expression.
    private func BindQualifiedNestedStructLiteral(
        outerConstructed StructSymbol,
        structLiteral StructLiteralExpressionSyntax
    ) BoundExpression {
        let container = outerConstructed.Definition ?? outerConstructed
        let literalArity = if structLiteral.TypeArgumentList != nil {
            structLiteral.TypeArgumentList!!.Arguments.Count
        } else {
            -1
        }
        var nestedType TypeSymbol?
        var declaringContainer StructSymbol? = outerConstructed
        if !$scope.TryLookupNestedTypeAlias(
            container,
            structLiteral.TypeIdentifier.ValueText,
            literalArity,
            out nestedType
        ) &&
            !$scope
            .TryLookupNestedTypeAliasIncludingInherited(
            outerConstructed,
            structLiteral.TypeIdentifier.ValueText,
            literalArity,
            out nestedType,
            out declaringContainer
        ) {
            Diagnostics.ReportUnableToFindType(
                structLiteral.TypeIdentifier.Location,
                structLiteral.TypeIdentifier.ValueText
            )
            return BoundErrorExpression(nil)
        }
        if nestedType is not StructSymbol nestedStructDef {
            Diagnostics.ReportUnableToFindType(
                structLiteral.TypeIdentifier.Location,
                structLiteral.TypeIdentifier.ValueText
            )
            return BoundErrorExpression(nil)
        }
        // The enclosing construction already flattens its own enclosing chain in
        // EnclosingTypeArguments; append its own TypeArguments so the nested
        // type sees the full outermost-first vector. declaringContainer is
        // never null here: it starts as outerConstructed (non-null) and is
        // only ever overwritten by TryLookupNestedTypeAliasIncludingInherited's
        // out parameter when that call returns true ([NotNullWhen(true)]).
        let enclosingArgs = FlattenConstructedEnclosingArguments(declaringContainer!!)
        return BindStructLiteralExpression(structLiteral, nestedStructDef.Definition ?? nestedStructDef, enclosingArgs)
    }

    /// Issue #1537: resolves a nested-type-naming expression evaluated UNDER a
    /// constructed generic receiver — e.g. `Middle[string]` (or the deeper
    /// `Middle[string].Deeper[y]`) under a receiver `Outer[int32]` —
    /// to the constructed nested type symbol, threading the receiver's flattened
    /// enclosing arguments plus each intervening segment's own arguments so the
    /// deepest segment carries the full outermost-first argument vector
    /// (`Outer`1+Middle`2<int32, string>`). Returns `false`
    /// (without diagnostics) when the expression does not name a nested type of
    /// the receiver, so the caller can fall back to the value/static-member path.
    /// @param receiver The constructed generic receiver the chain is nested under.
    /// @param typeExpr The nested-type-naming expression.
    /// @param constructedStruct The resolved constructed nested struct on success.
    /// @param constructedEnum The resolved constructed nested enum on success.
    /// @param preferredArity A terminal constructor's own arity, or -1 when inferred.
    /// @returns Whether the expression named a nested type of the receiver.
    private func TryResolveNestedTypeChainUnderReceiver(
        receiver StructSymbol,
        typeExpr ExpressionSyntax,
        out constructedStruct StructSymbol?,
        out constructedEnum EnumSymbol?,
        preferredArity int32 = -1
    ) bool {
        constructedStruct = nil
        constructedEnum = nil
        let segments = List[(Name string, Args ImmutableArray[TypeSymbol])]()
        if !TryFlattenUserTypeExpressionSegments(typeExpr, segments) || segments.Count == 0 {
            return false
        }
        var enclosingArgs = FlattenConstructedEnclosingArguments(receiver)
        var container TypeSymbol = receiver
        for var i = 0; i < segments.Count; i++ {
            let arity = if segments[i].Args.IsDefaultOrEmpty {
                (
                    if i == segments.Count - 1 {
                        preferredArity
                    } else {
                        -1
                    }
                )
            } else {
                segments[i].Args.Length
            }
            let constructorArity = i == segments.Count - 1 && segments[i].Args.IsDefaultOrEmpty && preferredArity >= 0
            let lookupContainer = (container as StructSymbol)?.Definition ?? container
            var nested TypeSymbol?
            if !$scope.TryLookupNestedTypeAlias(lookupContainer, segments[i].Name, arity, out nested) &&
                (
                !constructorArity || !$scope.TryLookupNestedTypeAlias(lookupContainer, segments[i].Name, -1, out nested)
            ) {
                if container is StructSymbol containerStruct &&
                    (
                    $scope.TryLookupNestedTypeAliasIncludingInherited(
                        containerStruct,
                        segments[i].Name,
                        arity,
                        out var inheritedNested,
                        out var inheritedOwner
                    ) ||
                        (
                        constructorArity && $scope.TryLookupNestedTypeAliasIncludingInherited(
                            containerStruct,
                            segments[i].Name,
                            -1,
                            out inheritedNested,
                            out inheritedOwner
                        )
                    )
                ) {
                    nested = inheritedNested
                    enclosingArgs = FlattenConstructedEnclosingArguments(inheritedOwner!!)
                } else {
                    return false
                }
            }
            if nested is EnumSymbol nestedEnum {
                if i < segments.Count - 1 {
                    return false
                }
                constructedEnum = if !enclosingArgs.IsDefaultOrEmpty {
                    EnumSymbol.ConstructNested(nestedEnum.Definition ?? nestedEnum, enclosingArgs)
                } else {
                    nestedEnum.Definition ?? nestedEnum
                }
                return true
            }
            if nested is not StructSymbol nestedStruct {
                return false
            }
            let def = nestedStruct.Definition ?? nestedStruct
            let ownArgs = segments[i].Args
            if !enclosingArgs.IsDefaultOrEmpty && !ownArgs.IsDefaultOrEmpty {
                constructedStruct = StructSymbol.ConstructNestedGeneric(
                    def,
                    enclosingArgs,
                    ownArgs,
                    $scope.References!!.MapClrTypeToReferences
                )
            } else if !enclosingArgs.IsDefaultOrEmpty {
                constructedStruct = StructSymbol.ConstructNested(
                    def,
                    enclosingArgs,
                    $scope.References!!.MapClrTypeToReferences
                )
            } else if !ownArgs.IsDefaultOrEmpty {
                constructedStruct = StructSymbol.Construct(def, ownArgs, $scope.References!!.MapClrTypeToReferences)
            } else {
                constructedStruct = def
            }
            if i == segments.Count - 1 {
                return true
            }
            // Inherited nested lookup needs the constructed owner at every
            // level, not just the accumulated arguments of its definition.
            enclosingArgs = FlattenConstructedEnclosingArguments(constructedStruct!!)
            container = constructedStruct!!
            constructedStruct = nil
        }
        return false
    }

    /// ADR-0089 / issue #1030: resolves `IName.StaticField` qualified
    /// access against an interface's static *state* (storage or const fields).
    /// Interface static fields have no per-implementer shape — they are plain
    /// CLR static fields on the interface TypeDef — so a read/write binds to a
    /// static (`receiver: null`) (cref:BoundFieldAccessExpression)
    /// with a `null` declaring struct (the emitter resolves the field by
    /// symbol identity). Non-field members fall through to an error.
    /// @param interfaceSym The interface receiver.
    /// @param rightPart The member being accessed.
    /// @returns The bound access, or a bound error expression.
    private func BindInterfaceStaticAccessorStep(
        interfaceSym InterfaceSymbol,
        rightPart ExpressionSyntax
    ) BoundExpression {
        let result = BindInterfaceStaticAccessorStepCore(interfaceSym, rightPart)
        RecordStaticTypeQualifier(result, interfaceSym, rightPart)
        return result
    }

    private func BindInterfaceStaticAccessorStepCore(
        interfaceSym InterfaceSymbol,
        rightPart ExpressionSyntax
    ) BoundExpression {
        // Issue #1030: a constructed generic interface (`IBox[int32]`) does not
        // re-declare its static fields — they live on the open definition. Look
        // the field up there, but keep `interfaceSym` (the constructed or open
        // symbol) as the carried owner so the emitter parents the field
        // reference at the correct TypeSpec and the interpreter keys storage per
        // construction.
        let fieldOwner = interfaceSym.Definition ?? interfaceSym
        switch rightPart {
            case ce is CallExpressionSyntax {
                return BindUserTypeStaticCall(interfaceSym, ce)
            }
            case ne is NameExpressionSyntax {
                return BindInterfaceStaticMemberAccess(interfaceSym, fieldOwner, ne)
            }
            case nested is AccessorExpressionSyntax {
                let head = BindInterfaceStaticAccessorStep(interfaceSym, nested.LeftPart)
                if head is BoundErrorExpression {
                    return head
                }
                return BindAccessorStep(head, nil, nested.RightPart)
            }
            default {
                return BoundErrorExpression(nil)
            }
        }
    }

    /// Issue #1433: resolves `IName.member` in non-call position against an
    /// interface's static members. A static field reads to a static
    /// (cref:BoundFieldAccessExpression) (issue #1030); a static
    /// (`shared`) method named here is a method group with a null receiver
    /// (overload selection deferred to the conversion classifier), mirroring the
    /// struct/class path in (cref:BindUserTypeStaticMemberAccess).
    /// @param interfaceSym The interface receiver (constructed or open).
    /// @param fieldOwner The interface definition owning static fields.
    /// @param ne The member being accessed.
    /// @returns The bound access, or a bound error expression.
    private func BindInterfaceStaticMemberAccess(
        interfaceSym InterfaceSymbol,
        fieldOwner InterfaceSymbol,
        ne NameExpressionSyntax
    ) BoundExpression {
        let memberName = ne.IdentifierToken.ValueText
        let field FieldSymbol? = fieldOwner.GetStaticField(memberName)
        if field != nil {
            if !AccessibilityChecker.IsAccessible(field.Accessibility, fieldOwner, function) {
                Diagnostics.ReportMemberInaccessible(ne.Location, field.Name, fieldOwner.Name, field.Accessibility)
            }
            let fieldType = interfaceSym.SubstituteMemberType(field.Type)
            return BoundFieldAccessExpression(
                nil,
                field,
                interfaceSym,
                if object.ReferenceEquals(fieldType, field.Type) {
                    default(TypeSymbol?)
                } else {
                    fieldType
                }
            )
        }
        // Issue #1433: a default-bodied static (`shared`) property on the
        // interface (ADR-0089 / issue #1019) read in non-call position. Static
        // interface properties are modeled as static-virtual accessor methods,
        // not on a `StaticProperties` bucket, so a direct read is lowered to a
        // call of the getter MethodDef — reusing the static-method-call emit
        // path. Only a concrete (non-abstract, default-bodied) getter can be
        // invoked directly on the interface type.
        for prop in fieldOwner.Properties {
            if prop.IsStatic && !prop.IsIndexer && prop.Name == memberName {
                if prop.GetterSymbol != nil && prop.HasGetter {
                    if !AccessibilityChecker.IsAccessible(prop.GetterAccessibility, fieldOwner, function) {
                        Diagnostics.ReportMemberInaccessible(
                            ne.Location,
                            prop.Name,
                            fieldOwner.Name,
                            prop.GetterAccessibility
                        )
                    }
                    return BoundCallExpression(
                        nil,
                        prop.GetterSymbol!!,
                        ImmutableArray[BoundExpression].Empty,
                        interfaceSym.SubstituteMemberType(prop.Type)
                    ){
                        StaticGenericInterfaceOwnerType = if interfaceSym.Definition != nil {
                            interfaceSym
                        } else {
                            default(InterfaceSymbol?)
                        }
                    }
                }
                Diagnostics.ReportUnableToFindMember(ne.Location, memberName)
                return BoundErrorExpression(nil)
            }
        }
        // ADR-0112: a static method named here in non-call position is a method
        // group with a null receiver, driven by the target delegate signature.
        let staticMethods = TypeMemberModel.GetMethods(interfaceSym, memberName, MemberQuery.Static(MemberKinds.Method))
        if TryBuildUserMethodGroup(receiver: nil, staticMethods, out var staticGroup) {
            return staticGroup!!
        }
        Diagnostics.ReportUnableToFindMember(ne.Location, memberName)
        return BoundErrorExpression(nil)
    }

    /// ADR-0089 / issue #1030: resolves an index-expression receiver of the
    /// form `IBox[int32]` to the constructed generic interface symbol when
    /// the indexed target names a generic interface definition and the index
    /// resolves to a type. Returns `false` for anything else (so the caller
    /// falls back to ordinary index/expression binding).
    /// @param index The candidate `Target[Index]` receiver.
    /// @param constructed The constructed generic interface on success.
    /// @returns Whether a constructed generic interface receiver was resolved.
    private func TryResolveConstructedGenericInterfaceReceiver(
        index IndexExpressionSyntax,
        @NotNullWhen(true) out constructed InterfaceSymbol?
    ) bool {
        constructed = nil
        if index.Target is not NameExpressionSyntax targetName {
            return false
        }
        if !binderCtx.TryLookupSourceType(
            $scope,
            targetName.IdentifierToken.ValueText,
            index.Indices.Count,
            getCurrentFunction(),
            out var alias,
            out _
        ) ||
            alias is not InterfaceSymbol ifaceDef ||
            !ifaceDef.IsGenericDefinition {
            return false
        }
        if !TryBindTypeArgumentExpressions(index.Indices, out var typeArgs) ||
            typeArgs.Length != ifaceDef
            .TypeParameters
            .Length {
            return false
        }
        constructed = InterfaceSymbol.Construct(ifaceDef, typeArgs, $scope.References!!.MapClrTypeToReferences)
        return true
    }

    /// Issue #1209: resolves a `Name[TypeArg]` index-expression receiver
    /// that appears in expression / member-access position to the constructed
    /// generic *type* it names — a user class/struct, a user interface, or an
    /// imported CLR generic type — so qualified static-member access
    /// (`Box[int32].Default`, `ArrayPool[uint8].Shared`) and static
    /// method calls bind against the construction rather than as element access.
    ///
    /// Disambiguation rule (avoids breaking genuine indexing such as
    /// `arr[i]` / `dict[key]`): the target must be a simple name that
    /// does NOT resolve to a value/variable in scope, AND must resolve to a
    /// generic type definition (user generic class/struct/interface, or imported
    /// CLR generic) whose arity matches the bracketed type-argument count, AND
    /// the bracket contents must parse as type arguments. When the name resolves
    /// to a value, this returns `false` and the caller binds element access
    /// as before.
    /// @param index The candidate `Name[TypeArg]` receiver.
    /// @param constructedStruct The constructed generic class/struct on success.
    /// @param constructedInterface The constructed generic interface on success.
    /// @param constructedImported The constructed imported CLR generic type on success.
    /// @returns Whether a constructed generic type receiver was resolved.
    private func TryResolveConstructedGenericTypeReceiver(
        index IndexExpressionSyntax,
        out constructedStruct StructSymbol?,
        out constructedInterface InterfaceSymbol?,
        out constructedImported ImportedClassSymbol?
    ) bool -> TryResolveConstructedGenericTypeReceiver(
        index,
        out constructedStruct,
        out constructedInterface,
        out constructedImported,
        out _
    )

    /// Issue #4051: the [`failureHandled`](paramref) overload of the
    /// index-expression resolver. See
    /// (cref:TryCloseImportedGenericTypeReceiver(Type, ImmutableArray{TypeSymbol}, ExpressionSyntax, out
    /// ImportedClassSymbol?, out bool))
    /// for what the flag means and why it is not a diagnostic-count snapshot.
    /// Only the IMPORTED close can set it — a user (cref:StructSymbol) /
    /// (cref:InterfaceSymbol) construction reports nothing here — so a
    /// caller that consumes only the user-symbol outputs can keep using the
    /// discarding overload above with no change in behaviour.
    /// @param index The candidate `Name[TypeArg]` receiver.
    /// @param constructedStruct The constructed generic class/struct on success.
    /// @param constructedInterface The constructed generic interface on success.
    /// @param constructedImported The constructed imported CLR generic type on success.
    /// @param failureHandled Whether a `false` result already reported its reason.
    /// @returns Whether a constructed generic type receiver was resolved.
    private func TryResolveConstructedGenericTypeReceiver(
        index IndexExpressionSyntax,
        out constructedStruct StructSymbol?,
        out constructedInterface InterfaceSymbol?,
        out constructedImported ImportedClassSymbol?,
        out failureHandled bool
    ) bool {
        constructedStruct = nil
        constructedInterface = nil
        constructedImported = nil
        failureHandled = false
        if index.Target is not NameExpressionSyntax targetName {
            return false
        }
        let name = targetName.IdentifierToken.ValueText
        // Genuine indexing (`arr[i]`, `dict[key]`) requires the target to name a
        // value. Only when the name is NOT a value do we consider the
        // constructed-generic-type interpretation.
        if $scope.TryLookupSymbol(name) is VariableSymbol {
            return false
        }
        // Gate on the name actually naming a generic type definition before
        // binding the bracket contents as type arguments, so that we never emit
        // spurious type diagnostics for a non-generic-type target.
        let arity = index.Indices.Count
        if targetName.IdentifierToken.Text == "managed" && binderCtx.CanUseIntrinsicAlias(
            $scope,
            targetName.IdentifierToken,
            getCurrentFunction(),
            expression: true
        ) {
            failureHandled = true
            if !ManagedReferenceTypes.TryResolveDefinition($scope.References!!, false, out var definition) ||
                !TryBindTypeArgumentExpressions(index.Indices, out var arguments) ||
                arguments.Length != 1 {
                Diagnostics.ReportManagedReference(
                    index.Location,
                    "managed reference types require one referent type and a matching runtime"
                )
                return false
            }
            return TryCloseImportedGenericTypeReceiver(
                definition!!,
                arguments,
                index,
                out constructedImported,
                out failureHandled
            )
        }
        if binderCtx.CanUseSpanAlias($scope, targetName.IdentifierToken, getCurrentFunction(), expression: true) {
            failureHandled = true
            if index.Indices.Count != 1 || !TryBuildTypeClauseFromExpression(index.Indices[0], out var elementClause) {
                Diagnostics.ReportNativeSpanType(index.Location, "span[T] requires exactly one element type")
                return false
            }
            let clause = TypeClauseSyntax(
                index.SyntaxTree,
                nil,
                nil,
                nil,
                targetName.IdentifierToken,
                index.OpenBracketToken,
                GSharp
                    .Core
                    .CodeAnalysis
                    .Syntax
                    .SeparatedSyntaxList[TypeClauseSyntax](ImmutableArray.Create[SyntaxNode](elementClause)),
                index.CloseBracketToken,
                nil
            )
            if bindTypeClause(clause) is not ImportedTypeSymbol spanType {
                return false
            }
            constructedImported = ImportedClassSymbol(spanType.Type, index, spanType, $scope.References)
            return true
        }
        if name == "slice" && binderCtx.CanUseNativeBufferAlias(
            $scope,
            targetName.IdentifierToken,
            getCurrentFunction(),
            expression: true
        ) {
            failureHandled = true
            if !NativeSliceTypes.TryResolveDefinition($scope.References!!, false, out var nativeDefinition) {
                Diagnostics.ReportNativeSliceRuntime(index.Location)
                return false
            }
            if !TryBindTypeArgumentExpressions(index.Indices, out var nativeArguments) || nativeArguments.Length != 1 {
                Diagnostics.ReportNativeSliceType(index.Location, "slice[T] requires one element type")
                return false
            }
            return TryCloseImportedGenericTypeReceiver(
                nativeDefinition,
                nativeArguments,
                index,
                out constructedImported,
                out failureHandled
            )
        }
        // Issue #1395: when a non-generic (arity-0) type and a generic type
        // share the same simple name (arity overloading, e.g. `Box` and
        // `Box[T]`), the arity-unaware lookup prefers the arity-0 type and the
        // generic receiver fails to resolve. Disambiguate using the bracketed
        // type-argument count so `Box[int32]` selects the arity-1 `Box[T]`.
        var userGenericDef = binderCtx.TryLookupSourceType(
            $scope,
            name,
            preferredArity: arity,
            getCurrentFunction(),
            out var alias,
            out var typeNameAmbiguous
        ) &&
            (
            (alias is StructSymbol sDef && sDef.IsGenericDefinition && sDef.TypeParameters.Length == arity) ||
                (alias is InterfaceSymbol iDef && iDef.IsGenericDefinition && iDef.TypeParameters.Length == arity)
        )
        var openClrType Type? = nil
        var genericAmbiguity ImportedTypeAmbiguity? = nil
        var clrGenericDef = !typeNameAmbiguous && $scope.TryLookupImportedGenericClass(
            name,
            arity,
            out openClrType,
            out genericAmbiguity
        )
        if userGenericDef {
            let importedGenericTakesPrecedence = clrGenericDef &&
                ImportedGenericTypeHasPrecedence(name, alias, openClrType, arity)
            userGenericDef = !importedGenericTakesPrecedence
            clrGenericDef = importedGenericTakesPrecedence
        }
        if clrGenericDef && genericAmbiguity != nil {
            Diagnostics.ReportAmbiguousImportedTypeReference(index.Location, name, genericAmbiguity)
            failureHandled = true
            return false
        }
        if !userGenericDef && !clrGenericDef {
            return false
        }
        if !TryBindTypeArgumentExpressions(index.Indices, out var typeArgs) || typeArgs.Length != arity {
            return false
        }
        if userGenericDef {
            switch alias {
                case structDef is StructSymbol {
                    constructedStruct = StructSymbol.Construct(
                        structDef,
                        typeArgs,
                        $scope.References!!.MapClrTypeToReferences
                    )
                    return true
                }
                case ifaceDef is InterfaceSymbol {
                    constructedInterface = InterfaceSymbol.Construct(
                        ifaceDef,
                        typeArgs,
                        $scope.References!!.MapClrTypeToReferences
                    )
                    return true
                }
            }
        }
        // Imported CLR generic type: close the open generic definition over the
        // CLR types of the bound type arguments (e.g. ArrayPool`1 + byte ->
        // ArrayPool<byte>) and surface it as an imported class so the existing
        // static-member / static-call binding path resolves members against the
        // closed construction.
        return openClrType != nil &&
            TryCloseImportedGenericTypeReceiver(
            openClrType,
            typeArgs,
            index,
            out constructedImported,
            out failureHandled
        )
    }

    /// Issue #1323: resolves a constructed generic type receiver from a
    /// (cref:GenericNameExpressionSyntax) (`Box[int32?]`,
    /// `Pair[int, string]`, `List[List[int32]]`). Unlike the
    /// index-expression form, the type arguments are real
    /// (cref:TypeClauseSyntax) nodes, so nullable/array/nested-generic
    /// arguments bind directly without needing to be reshaped from an
    /// expression. Mirrors the gating of the index-expression overload: the name
    /// must NOT be a value and must name a generic type definition (user
    /// class/struct/interface or imported CLR generic) of matching arity.
    /// @param generic The constructed-generic type reference.
    /// @param constructedStruct The constructed generic class/struct on success.
    /// @param constructedInterface The constructed generic interface on success.
    /// @param constructedImported The constructed imported CLR generic type on success.
    /// @returns Whether a constructed generic type receiver was resolved.
    private func TryResolveConstructedGenericTypeReceiver(
        generic GenericNameExpressionSyntax,
        out constructedStruct StructSymbol?,
        out constructedInterface InterfaceSymbol?,
        out constructedImported ImportedClassSymbol?
    ) bool -> TryResolveConstructedGenericTypeReceiver(
        generic,
        out constructedStruct,
        out constructedInterface,
        out constructedImported,
        out _
    )

    /// Issue #4051: the [`failureHandled`](paramref) overload of the
    /// generic-name resolver, mirroring the index-expression one.
    /// @param generic The constructed-generic type reference.
    /// @param constructedStruct The constructed generic class/struct on success.
    /// @param constructedInterface The constructed generic interface on success.
    /// @param constructedImported The constructed imported CLR generic type on success.
    /// @param failureHandled Whether a `false` result already reported its reason.
    /// @returns Whether a constructed generic type receiver was resolved.
    private func TryResolveConstructedGenericTypeReceiver(
        generic GenericNameExpressionSyntax,
        out constructedStruct StructSymbol?,
        out constructedInterface InterfaceSymbol?,
        out constructedImported ImportedClassSymbol?,
        out failureHandled bool
    ) bool {
        constructedStruct = nil
        constructedInterface = nil
        constructedImported = nil
        failureHandled = false
        let name = generic.Identifier.ValueText
        if generic
            .Identifier
            .Text == "managed" &&
            (
            generic.ReadOnlyManagedModifier != nil || binderCtx.CanUseIntrinsicAlias(
                $scope,
                generic.Identifier,
                getCurrentFunction(),
                expression: true
            )
        ) {
            failureHandled = true
            if binderCtx.HasValueName($scope, name) {
                Diagnostics.ReportManagedReference(
                    generic.Location,
                    "a same-named value shadows the managed type receiver; use the qualified runtime type"
                )
                return false
            }
            let arguments = generic.TypeArgumentList
            let clause = TypeClauseSyntax(
                generic.SyntaxTree,
                nil,
                nil,
                nil,
                generic.Identifier,
                arguments.OpenBracketToken,
                arguments.Arguments,
                arguments.CloseBracketToken,
                nil
            ){ReadOnlyManagedModifier = generic.ReadOnlyManagedModifier}
            if bindTypeClause(clause) is not ImportedTypeSymbol managedType {
                return false
            }
            constructedImported = ImportedClassSymbol(managedType.Type, generic, managedType, $scope.References)
            return true
        }
        if generic
            .Identifier
            .Text == "span" &&
            (
            generic.ReadOnlySpanModifier != nil || binderCtx.CanUseSpanAlias(
                $scope,
                generic.Identifier,
                getCurrentFunction(),
                expression: true
            )
        ) {
            failureHandled = true
            if binderCtx.HasValueName($scope, name) {
                Diagnostics.ReportNativeSpanType(
                    generic.Location,
                    "a same-named value shadows the span type receiver; use System.ReadOnlySpan[T] explicitly"
                )
                return false
            }
            let arguments = generic.TypeArgumentList
            let clause = TypeClauseSyntax(
                generic.SyntaxTree,
                nil,
                nil,
                nil,
                generic.Identifier,
                arguments.OpenBracketToken,
                arguments.Arguments,
                arguments.CloseBracketToken,
                nil
            ){ReadOnlySpanModifier = generic.ReadOnlySpanModifier}
            if bindTypeClause(clause) is not ImportedTypeSymbol spanType {
                return false
            }
            constructedImported = ImportedClassSymbol(spanType.Type, generic, spanType, $scope.References)
            return true
        }
        if name == "slice" &&
            (
            generic.ReadOnlySliceModifier != nil || binderCtx.CanUseNativeBufferAlias(
                $scope,
                generic.Identifier,
                getCurrentFunction(),
                expression: true
            )
        ) {
            let args = generic.TypeArgumentList
            let clause = TypeClauseSyntax(
                generic.SyntaxTree,
                nil,
                nil,
                nil,
                generic.Identifier,
                args.OpenBracketToken,
                args.Arguments,
                args.CloseBracketToken,
                nil
            ){ReadOnlySliceModifier = generic.ReadOnlySliceModifier}
            let nativeType = bindTypeClause(clause)
            failureHandled = true
            if nativeType is not ImportedTypeSymbol native {
                return false
            }
            constructedImported = ImportedClassSymbol(native.Type, generic, native, $scope.References)
            return true
        }
        // A value-named receiver is genuine element access, never a type.
        if $scope.TryLookupSymbol(name) is VariableSymbol {
            return false
        }
        let argClauses = generic.TypeArgumentList.Arguments
        let arity = argClauses.Count
        // Issue #1395: same arity-collision disambiguation as the
        // index-expression overload — select the same-name type whose generic
        // arity matches the supplied type-argument count so `Box[int32]`
        // resolves to `Box[T]` rather than the non-generic `Box`.
        var userGenericDef = binderCtx.TryLookupSourceType(
            $scope,
            name,
            preferredArity: arity,
            getCurrentFunction(),
            out var alias,
            out var typeNameAmbiguous
        ) &&
            (
            (alias is StructSymbol sDef && sDef.IsGenericDefinition && sDef.TypeParameters.Length == arity) ||
                (alias is InterfaceSymbol iDef && iDef.IsGenericDefinition && iDef.TypeParameters.Length == arity)
        )
        var openClrType Type? = nil
        var genericAmbiguity ImportedTypeAmbiguity? = nil
        var clrGenericDef = !typeNameAmbiguous && $scope.TryLookupImportedGenericClass(
            name,
            arity,
            out openClrType,
            out genericAmbiguity
        )
        if userGenericDef {
            let importedGenericTakesPrecedence = clrGenericDef &&
                ImportedGenericTypeHasPrecedence(name, alias, openClrType, arity)
            userGenericDef = !importedGenericTakesPrecedence
            clrGenericDef = importedGenericTakesPrecedence
        }
        if clrGenericDef && genericAmbiguity != nil {
            Diagnostics.ReportAmbiguousImportedTypeReference(generic.Location, name, genericAmbiguity)
            failureHandled = true
            return false
        }
        if !userGenericDef && !clrGenericDef {
            return false
        }
        let typeArgsBuilder = ImmutableArray.CreateBuilder[TypeSymbol](arity)
        for clause in argClauses {
            let bound TypeSymbol? = bindTypeClause(clause)
            if bound == nil {
                return false
            }
            typeArgsBuilder.Add(bound)
        }
        let typeArgs = typeArgsBuilder.ToImmutable()
        if userGenericDef {
            switch alias {
                case structDef is StructSymbol {
                    constructedStruct = StructSymbol.Construct(
                        structDef,
                        typeArgs,
                        $scope.References!!.MapClrTypeToReferences
                    )
                    return true
                }
                case ifaceDef is InterfaceSymbol {
                    constructedInterface = InterfaceSymbol.Construct(
                        ifaceDef,
                        typeArgs,
                        $scope.References!!.MapClrTypeToReferences
                    )
                    return true
                }
            }
        }
        return openClrType != nil &&
            TryCloseImportedGenericTypeReceiver(
            openClrType,
            typeArgs,
            generic,
            out constructedImported,
            out failureHandled
        )
    }

    private func ImportedGenericTypeHasPrecedence(
        name string,
        sourceType TypeSymbol?,
        importedType Type?,
        requestedArity int32
    ) bool -> sourceType != nil &&
        importedType != nil &&
        binderCtx.ImportedTypeOverridesSourceType(
        $scope,
        name,
        sourceType,
        requestedArity,
        getCurrentFunction(),
        importedType
    )

    /// Issue #1559: syntax-shape-agnostic dispatcher over the two
    /// constructed-generic-type receiver resolvers. A qualified generic-type
    /// receiver `G[T1..Tn]` reaches the binder as either an
    /// (cref:IndexExpressionSyntax) (single type argument that also reads
    /// as an index — `Foo[T]`, `Box[int32]`) or a
    /// (cref:GenericNameExpressionSyntax) (arguments the parser could only
    /// shape as types — `Box[int32?]`, `Pair[int32, string]`,
    /// `Box[List[int32]]`). Both read (member access) and write (assignment
    /// target) receiver resolution route through here so the WRITE path mirrors
    /// the READ path ((cref:BindAccessorExpression)) exactly rather than
    /// duplicating shape-specific logic.
    /// @param receiver The candidate constructed-generic-type receiver syntax.
    /// @param constructedStruct The constructed generic class/struct on success.
    /// @param constructedInterface The constructed generic interface on success.
    /// @param constructedImported The constructed imported CLR generic type on success.
    /// @returns Whether a constructed generic type receiver was resolved.
    private func TryResolveConstructedGenericTypeReceiver(
        receiver ExpressionSyntax,
        out constructedStruct StructSymbol?,
        out constructedInterface InterfaceSymbol?,
        out constructedImported ImportedClassSymbol?
    ) bool -> TryResolveConstructedGenericTypeReceiver(
        receiver,
        out constructedStruct,
        out constructedInterface,
        out constructedImported,
        out _
    )

    /// Issue #4051: the [`failureHandled`](paramref) overload of the
    /// shape-agnostic dispatcher, so a write/compound-assignment receiver gets
    /// the same "the failure explained itself" answer the read path gets.
    /// @param receiver The candidate constructed-generic-type receiver syntax.
    /// @param constructedStruct The constructed generic class/struct on success.
    /// @param constructedInterface The constructed generic interface on success.
    /// @param constructedImported The constructed imported CLR generic type on success.
    /// @param failureHandled Whether a `false` result already reported its reason.
    /// @returns Whether a constructed generic type receiver was resolved.
    private func TryResolveConstructedGenericTypeReceiver(
        receiver ExpressionSyntax,
        out constructedStruct StructSymbol?,
        out constructedInterface InterfaceSymbol?,
        out constructedImported ImportedClassSymbol?,
        out failureHandled bool
    ) bool {
        constructedStruct = nil
        constructedInterface = nil
        constructedImported = nil
        failureHandled = false
        switch receiver {
            case index is IndexExpressionSyntax when !index.IsNullConditional {
                return TryResolveConstructedGenericTypeReceiver(
                    index,
                    out constructedStruct,
                    out constructedInterface,
                    out constructedImported,
                    out failureHandled
                )
            }
            case generic is GenericNameExpressionSyntax {
                return TryResolveConstructedGenericTypeReceiver(
                    generic,
                    out constructedStruct,
                    out constructedInterface,
                    out constructedImported,
                    out failureHandled
                )
            }
            case accessorChain is AccessorExpressionSyntax when !accessorChain.IsNullConditional {
                // A package-qualified generic type receiver written by cs2gs,
                // e.g. `Oahu.Aux.Diagnostics.TreeDecomposition[T].field = v`. The
                // leading namespace segments are redundant for a source type; peel
                // them and re-dispatch on the bare constructed-generic terminal.
                let peeled = PeelNamespacePrefix(accessorChain)
                if !object.ReferenceEquals(peeled, accessorChain) &&
                    (peeled is IndexExpressionSyntax or GenericNameExpressionSyntax) {
                    return TryResolveConstructedGenericTypeReceiver(
                        peeled,
                        out constructedStruct,
                        out constructedInterface,
                        out constructedImported,
                        out failureHandled
                    )
                }
                return false
            }
            default {
                return false
            }
        }
    }

    /// Whether [`segment`](paramref) is a pure namespace/package prefix
    /// component — it does not name a known type/alias, an import alias, or an
    /// imported class, and (only for the leading segment of a chain, per
    /// [`isLeadingSegment`](paramref)) does not name an in-scope value.
    /// cs2gs fully-qualifies type references, so a leading run of such segments
    /// in front of a same-compilation source type is redundant and must be
    /// peeled before binding by simple name.
    ///
    /// The in-scope-value check is restricted to the leading segment because it
    /// is what distinguishes a genuine value-access chain (e.g.
    /// `myOahu.Foo.Ctor()`, where `myOahu` really is a value) from a
    /// namespace-qualified construction. Once a segment has already been
    /// accepted as a namespace-prefix component (i.e. peeling is past the first
    /// segment), the chain can no longer be reinterpreted as a value-access
    /// chain — there is no value at its head to access `.member` on — so a
    /// later segment coincidentally sharing a name with an unrelated in-scope
    /// value (e.g. a field or const declared on the enclosing type, see issue
    /// #2419) is not a genuine alternate interpretation and must not stop
    /// peeling.
    /// @param segment The dotted-name segment to classify.
    /// @param isLeadingSegment Whether [`segment`](paramref) is the first segment being peeled from
    /// the chain (as opposed to a later, already-committed continuation).
    /// @returns Whether the segment is a pure namespace/package prefix.
    private func IsNamespacePrefixSegment(segment string, isLeadingSegment bool = true) bool -> (
        !isLeadingSegment || !($scope.TryLookupSymbol(segment) is VariableSymbol)
    ) &&
        !binderCtx.TryLookupSourceType($scope, segment, preferredArity: -1, getCurrentFunction(), out _, out _) &&
        !($scope.TryLookupImport(segment, out var import_) && import_!!.IsAlias) &&
        !$scope.TryLookupImportedClass(segment, declaration: nil, out _)

    private func IsQualifiedSourceTypeBoundary(
        peeledSegments List[string],
        segment string
    ) bool -> peeledSegments.Count > 0 &&
        $scope.TryLookupQualifiedSourceType(string.Join(".", peeledSegments) + "." + segment, preferredArity: -1, out _)

    /// Peels a leading run of pure namespace/package segments off a dotted
    /// accessor chain, returning the first non-namespace remainder (unchanged
    /// when the head is not a namespace segment). Used to strip a redundant
    /// package prefix cs2gs emits in front of a same-compilation source type.
    /// @param expr The dotted accessor chain to peel.
    /// @returns The first non-namespace remainder of the chain.
    private func PeelNamespacePrefix(expr ExpressionSyntax) ExpressionSyntax {
        var current = expr
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
        return current
    }

    /// Closes an open imported CLR generic definition over the CLR types of the
    /// bound type arguments (e.g. `ArrayPool`1` + `byte` ->
    /// `ArrayPool<byte>`) and surfaces it as an
    /// (cref:ImportedClassSymbol) so the existing static-member /
    /// static-call binding path resolves members against the closed
    /// construction. Shared by the index-expression and generic-name receiver
    /// resolvers (Issue #1209 / Issue #1323).
    private func TryCloseImportedGenericTypeReceiver(
        openClrType Type,
        typeArgs ImmutableArray[TypeSymbol],
        receiverSyntax ExpressionSyntax,
        @NotNullWhen(true) out constructedImported ImportedClassSymbol?
    ) bool -> TryCloseImportedGenericTypeReceiver(openClrType, typeArgs, receiverSyntax, out constructedImported, out _)

    /// Issue #4051: the [`failureHandled`](paramref) overload. The close
    /// can now fail for a reason it has already EXPLAINED — a type argument
    /// that violates the open definition's declared constraint (GS0152, added
    /// by #4032). A caller that treats every `false` as "not a type" then
    /// re-reads `Name[Arg]` as an index expression and invents a second,
    /// FALSE reason; `Nullable[string].Value` reported "Variable
    /// 'Nullable' doesn't exist" and "Variable 'string' doesn't exist" beside
    /// the accurate diagnostic, and `string` is a predefined type keyword.
    /// @remarks The flag is taken from the checker's RETURN VALUE, never from a
    /// `Diagnostics.Count` snapshot: `ReportUnsatisfiedGenericTypeConstraint`
    /// suppresses a byte-identical repeat (it is reached twice or three times
    /// per expression, because the binder probes the same receiver through
    /// several entry points before committing to a reading of it), so on the
    /// second probe the bag does not grow while the answer is still "this
    /// construction is invalid, stop". A count snapshot would therefore read
    /// "unexplained" on exactly the probe whose caller decides the message.
    /// @param openClrType The open generic CLR definition.
    /// @param typeArgs The bound type arguments.
    /// @param receiverSyntax The receiver syntax the diagnostic anchors to.
    /// @param constructedImported The closed construction on success.
    /// @param failureHandled On a `false` result, whether the failure already
    /// reported its own reason and the caller must not invent another.
    /// @returns Whether the construction closed.
    private func TryCloseImportedGenericTypeReceiver(
        openClrType Type,
        typeArgs ImmutableArray[TypeSymbol],
        receiverSyntax ExpressionSyntax,
        @NotNullWhen(true) out constructedImported ImportedClassSymbol?,
        out failureHandled bool
    ) bool {
        constructedImported = nil
        failureHandled = false
        let clrArgs = [typeArgs.Length]Type
        for var i = 0; i < typeArgs.Length; i++ {
            // Issue #1330 (#313 / #671): an in-scope generic type-parameter
            // argument (`Comparer[TResult].Create(...)`, `Comparer[U].Default`)
            // — or any other symbolic type that has no CLR type yet (a
            // not-yet-emitted user type) — has no concrete System.Type to close
            // the imported generic over. Mirror ConstructIfGeneric's type-erased
            // generic model and project such an argument onto System.Object for
            // the closed CLR shape, so the constructed-generic *type* receiver is
            // well formed and static-member access / static calls resolve. This
            // keeps the type-parameter receiver consistent with how the same
            // `Comparer[TResult]` shape binds in type-clause position.
            var clr Type? = if TypeSymbol.ContainsTypeParameter(typeArgs[i]) {
                typeof(object)
            } else {
                NullableTypeSymbol.GetEffectiveClrType(typeArgs[i])
            }
            clr ??= typeof(object)
            // Project the host CLR type argument onto the resolver's reference
            // set so it shares the open type's load context (its
            // MetadataLoadContext when references are supplied via /reference:),
            // which MakeGenericType requires (mirrors Binder.BindGenericClrType).
            clrArgs[i] = $scope.References!!.MapClrTypeToReferences(clr)!!
        }
        // Issue #4032 (review finding 1): a static member reached through a
        // closed imported generic — `Handler[string].Describe()` — closes the
        // receiver here, and this site did not ask the constraints. Measured on
        // the first review build: it emitted an instantiation the CLR refuses
        // and threw TypeLoadException. This is the receiver-shaped sibling of
        // the direct-construction and literal sites.
        if Binder.ReportUnsatisfiedGenericTypeConstraint(
            Diagnostics,
            openClrType,
            clrArgs,
            typeArgs,
            receiverSyntax.Location
        ) {
            // Issue #4051: this failure EXPLAINED itself. Say so, so the caller
            // stops rather than re-reading `Name[Arg]` as an index expression
            // and reporting the type argument as a missing variable.
            failureHandled = true
            return false
        }
        try {
            let closed = openClrType.MakeGenericType(clrArgs)
            // Issues #1330/#2670: when any type argument is symbolic (including
            // a nested imported generic over a same-compilation user type), the
            // closed CLR shape above contains an object-erased slot. Carry the
            // symbolic constructed view alongside it so static-member access and
            // static calls recover symbolic member/return types
            // (`Comparer[TResult].Default : Comparer[TResult]`) and the emitter
            // parents the static member reference at the constructed
            // `Comparer<!TResult>` TypeSpec instead of the erased
            // `Comparer<object>` — yielding verifiable IL exactly as the
            // concrete-argument receiver does.
            // ADR-0172: a named-tuple-bearing argument at any nesting depth
            // (`List[List[(a int32, b string)]]`) shares its CLR backing with
            // the unnamed shape — only the symbolic view preserves the names.
            // Issue #3962: a fixed-length array `[N]T` shares its CLR backing
            // (`T[]`) with `[]T` and with every other length, so without the
            // symbolic view `EqualityComparer[[3]int32].Default` is exposed as
            // a metadata-only `EqualityComparer<int32[]>` and flows into an
            // `EqualityComparer[[4]int32]` slot through the metadata-recovery
            // leniency — the same erasure this issue closes elsewhere.
            // Issue #4024: the SLICE spelling `[]T` shares that backing and is
            // retained by the same gate, so `EqualityComparer[[]int32].Default`
            // no longer reads as a metadata-only `EqualityComparer<int32[]>`.
            let constructedReceiver = ImportedTypeSymbol.GetConstructed(closed, openClrType, typeArgs)
            let symbolicReceiver = if NativeSliceTypes.IsDefinition(closed, out _) ||
                ManagedReferenceTypes.IsDefinition(closed, out _) || typeArgs.Any(
                (a TypeSymbol) -> TypeSymbol.RequiresSymbolicProjection(a) || TypeSymbol.ContainsNamedTupleElements(
                    a
                ) ||
                    TypeSymbol.ContainsSourceArrayShape(a)
            ) {
                constructedReceiver
            } else {
                default(ImportedTypeSymbol?)
            }
            constructedImported = ImportedClassSymbol(
                closed,
                receiverSyntax,
                symbolicReceiver,
                $scope.References,
                constructedReceiver
            )
            return true
        } catch (ArgumentException) {
            return false
        }
    }

    /// ADR-0089 / issue #1030: binds the type-argument expression(s) of a
    /// generic-interface index receiver (`int32` in `IBox[int32]`) to
    /// (cref:TypeSymbol)s. Supports a single argument or a comma list
    /// (`IPair[int32, string]`). Each argument must be a simple/qualified
    /// name or a nested generic; non-type expressions cause a `false`
    /// result.
    /// @param argsSyntax The index expression's argument syntax.
    /// @param typeArgs The bound type arguments on success.
    /// @returns Whether every argument resolved to a type.
    private func TryBindTypeArgumentExpressions(
        argsSyntax ExpressionSyntax,
        out typeArgs ImmutableArray[TypeSymbol]
    ) bool {
        typeArgs = default(ImmutableArray[TypeSymbol])
        let builder = ImmutableArray.CreateBuilder[TypeSymbol]()
        for argExpr in FlattenCommaList(argsSyntax) {
            if !TryBuildTypeClauseFromExpression(argExpr, out var typeClause) {
                return false
            }
            let bound TypeSymbol? = bindTypeClause(typeClause)
            if bound == nil {
                return false
            }
            builder.Add(bound)
        }
        if builder.Count == 0 {
            return false
        }
        typeArgs = builder.ToImmutable()
        return true
    }

    private func TryBindTypeArgumentExpressions(
        argumentSyntaxes GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[ExpressionSyntax],
        out typeArgs ImmutableArray[TypeSymbol]
    ) bool {
        let builder = ImmutableArray.CreateBuilder[TypeSymbol](argumentSyntaxes.Count)
        for argumentSyntax in argumentSyntaxes {
            if !TryBindTypeArgumentExpressions(argumentSyntax, out var argumentTypes) {
                typeArgs = default(ImmutableArray[TypeSymbol])
                return false
            }
            builder.AddRange(argumentTypes)
        }
        typeArgs = builder.MoveToImmutable()
        return typeArgs.Length > 0
    }

    /// Issues #1201 / #3334: attempts to resolve an unqualified identifier
    /// against static members exposed by a non-alias imported type or referenced
    /// package. Binds against the single match through the same static-member
    /// paths used by explicit CLR type access; reports GS0414 when two or more
    /// imported containers expose a member of that name.
    /// @param syntax The bare-name reference being resolved.
    /// @param result The bound static-member access, when one is produced.
    /// @returns `true` when an imported static member matched (or an ambiguity was reported).
    private func TryBindImportedStaticMember(
        syntax NameExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let name = syntax.IdentifierToken.ValueText
        var match StructSymbol? = nil
        var ambiguous = false
        for importedType in binderCtx.GetStaticImportTypes() {
            if !BinderContext.ImportedTypeExposesStaticMember(importedType, name) {
                continue
            }
            if match == nil {
                match = importedType
            } else if !object.ReferenceEquals(match, importedType) {
                ambiguous = true
                break
            }
        }
        if ambiguous {
            Diagnostics.ReportAmbiguousImportedStaticMember(syntax.IdentifierToken.Location, name)
            result = BoundErrorExpression(nil)
            return true
        }
        if match != nil {
            result = BindUserTypeStaticMemberAccess(match, syntax)
            return true
        }
        // Issues #3334 / ADR-0134: fall back to static members on imported CLR
        // types and referenced packages' synthetic `<Program>` holders. Only
        // consulted when no same-compilation source class exposed the member.
        var clrMatch Type? = nil
        var clrAmbiguous = false
        for clrType in $scope.EnumerateStaticImportClrTypes() {
            if !BinderContext.ClrTypeExposesStaticMember(clrType, name) {
                continue
            }
            if clrMatch == nil {
                clrMatch = clrType
            } else if !clrMatch.IsSameAs(clrType) {
                clrAmbiguous = true
                break
            }
        }
        if clrAmbiguous {
            Diagnostics.ReportAmbiguousImportedStaticMember(syntax.IdentifierToken.Location, name)
            result = BoundErrorExpression(nil)
            return true
        }
        if clrMatch != nil {
            let classSymbol = ImportedClassSymbol(clrMatch, syntax, references: $scope.References)
            result = BindAccessorStep(receiver: nil, classSymbol, syntax)
            return true
        }
        return false
    }

    /// ADR-0156 Phase 2: attempts to resolve an unqualified identifier
    /// against the static members of a prior interactive submission's
    /// `<Program>` container — a top-level global (static field)
    /// or function (static method group). Submissions are consulted newest
    /// first, so a redefinition in a later cell shadows earlier cells; the
    /// first submission declaring the name wins outright (no ambiguity
    /// diagnostics, mirroring the evaluator's scope-chain shadowing).
    /// @param syntax The identifier syntax naming the prospective submission member.
    /// @param result The bound submission-member access, when one is produced.
    /// @returns `true` when a prior submission declared the member.
    private func TryBindSubmissionStaticMember(
        syntax NameExpressionSyntax,
        @NotNullWhen(true) out result BoundExpression?
    ) bool {
        result = nil
        let submissionImports SubmissionImports? = $scope.SubmissionImports
        if submissionImports == nil {
            return false
        }
        let name = syntax.IdentifierToken.ValueText
        if !submissionImports.TryFindMemberContainer($scope.References!!, name, out var programType) {
            return false
        }
        if programType == nil {
            return false
        }
        let classSymbol = ImportedClassSymbol(programType, syntax, references: $scope.References)
        result = BindAccessorStep(receiver: nil, classSymbol, syntax)
        // Issue #3185: a prior-cell GLOBAL surfaces as a static-field read.
        // Mark it addressable (and carry the source-side read-only flag) so
        // member writes and mutating method calls through this receiver load
        // the field's address (`ldsflda`) and mutate the stored global in
        // place — never a silently-dropped struct copy — mirroring how a
        // same-cell global (a static field of the current <Program>) behaves.
        if result is BoundClrPropertyAccessExpression{Receiver: nil, Member: FieldInfo globalField} fieldRead &&
            submissionImports
            .TryFindGlobalVariable($scope.References!!, name, out _, out var declaredGlobal) {
            // Issue #3308: the field read surfaces the global's CLR
            // projection (e.g. `chan T` as imported `Channel[T]`), which
            // strips the magic-symbol identity every channel/slice/array
            // operation type-checks against. Reverse-project it, steered by
            // the declaring submission's source-side type.
            result = BoundClrPropertyAccessExpression(
                fieldRead.Syntax,
                receiver: nil,
                fieldRead.Member,
                SubmissionGlobalTypeProjection.ReverseProject(
                    fieldRead.Type,
                    globalField.FieldType,
                    declaredGlobal?.Type,
                    $scope.References!!
                ),
                fieldRead.StaticContainerType,
                isAddressableStaticField: true,
                isReadOnlySubmissionGlobal: declaredGlobal?.IsReadOnly == true
            )
        }
        // Issue #3184: a prior-cell top-level FUNCTION referenced as a value
        // (`let g = addOne`) surfaces as an imported CLR method group on the
        // prior submission's <Program> container. Mirror the same-cell
        // method-group rule (TryBindSingleMethodGroup binds a single
        // non-generic candidate eagerly with its natural function type):
        // resolve a single-candidate group to a delegate of its natural
        // `FunctionTypeSymbol` so an untyped `let` infers a callable type.
        // Overloaded/generic groups stay unresolved for target-typed
        // conversion, exactly like their same-cell counterparts.
        if result is BoundClrMethodGroupExpression{ResolvedMethod: nil} submissionGroup &&
            submissionGroup
            .Candidates
            .Length == 1 &&
            TryGetNaturalClrMethodGroupType(submissionGroup, out var naturalFunctionType) {
            result = conversions.BindConversion(syntax.Location, submissionGroup, naturalFunctionType)
        }
        return true
    }

    private func BindUserTypeStaticMemberAccess(structSym StructSymbol, ne NameExpressionSyntax) BoundExpression {
        let memberName = ne.IdentifierToken.ValueText
        // ADR-0112: static field/property lookups go through the canonical layer.
        if TypeMemberModel.TryGetStaticFieldIncludingInherited(
            structSym,
            memberName,
            out var field,
            out var fieldOwner
        ) {
            if !AccessibilityChecker.IsAccessible(field.Accessibility, fieldOwner, function) {
                Diagnostics.ReportMemberInaccessible(ne.Location, field.Name, fieldOwner.Name, field.Accessibility)
            }
            let fieldType = fieldOwner.SubstituteMemberType(field.Type)
            return BoundFieldAccessExpression(nil, receiver: nil, fieldOwner, field, fieldType, narrowedType: nil)
        }
        if TypeMemberModel.TryGetStaticPropertyIncludingInherited(
            structSym,
            memberName,
            out var prop,
            out var propertyOwner
        ) {
            if !AccessibilityChecker.IsAccessible(prop.GetterAccessibility, propertyOwner, function) {
                Diagnostics.ReportMemberInaccessible(
                    ne.Location,
                    prop.Name,
                    propertyOwner.Name,
                    prop.GetterAccessibility
                )
            }
            return BoundPropertyAccessExpression(nil, receiver: nil, propertyOwner, prop)
        }
        // ADR-0112: a static (shared) method named here in non-call position is a
        // method group with a null receiver. Overload selection (when more than
        // one shared overload shares the name) is deferred to the conversion
        // classifier, driven by the target delegate signature.
        let staticMethods = TypeMemberModel.GetMethods(
            structSym,
            memberName,
            MemberQuery.InheritedStatic(MemberKinds.Method)
        )
        if TryBuildUserMethodGroup(receiver: nil, staticMethods, out var staticGroup, staticOwnerType: structSym) {
            return staticGroup!!
        }
        let inheritedImportedType = TypeMemberModel.GetNearestImportedBase(structSym)
        if inheritedImportedType?.ClrType is Type {
            let imported = CreateInheritedImportedClassSymbol(inheritedImportedType!!, ne)
            return BindAccessorStep(receiver: nil, imported, ne)
        }
        Diagnostics.ReportUnableToFindMember(ne.Location, memberName)
        return BoundErrorExpression(nil)
    }

    internal func BindUserTypeStaticCall(
        structSym StructSymbol,
        ce CallExpressionSyntax
    ) BoundExpression -> BindUserTypeStaticCall(cast[TypeSymbol](structSym), ce)

    /// Issue #1433: resolves `TypeName.method(args)` for a static
    /// (`shared`) method declared on a user struct/class OR interface. The
    /// member-resolution and overload/substitution logic is identical for both
    /// owner kinds (it routes through the canonical (cref:TypeMemberModel)
    /// layer, ADR-0112); only the generic-owner carried to the emitter differs:
    /// a constructed generic struct goes through
    /// (cref:BoundCallExpression.StaticGenericOwnerType) (issue #1209) and
    /// a constructed generic interface through
    /// (cref:BoundCallExpression.StaticGenericInterfaceOwnerType) (issue
    /// #1030 parenting extended to methods) so the call is parented at the
    /// correct construction `TypeSpec`. A non-generic owner of either kind
    /// emits a bare `MethodDef` token.
    internal func BindUserTypeStaticCall(ownerType TypeSymbol, ce CallExpressionSyntax) BoundExpression {
        let structSym StructSymbol? = ownerType as StructSymbol
        let ifaceSym = ownerType as InterfaceSymbol
        let methodName = ce.Identifier.ValueText
        if !overloads.TryAnalyzeCallArgumentLayout(ce.Arguments, out _, out var argumentNames) {
            return BoundErrorExpression(nil)
        }
        let boundArguments = ImmutableArray.CreateBuilder[BoundExpression]()
        var deferredStaticLambdaIndices List[int32]? = nil
        var staticArgIndex = 0
        for argument in ce.Arguments {
            let inner = OverloadResolver.UnwrapNamedArgumentValue(argument)
            var boundArgument BoundExpression? = nil
            let refArgument RefArgumentExpressionSyntax? = inner as RefArgumentExpressionSyntax
            if refArgument != nil {
                boundArgument = BindRefArgumentExpression(refArgument, parameter: nil)
            }
            if boundArgument == nil && IsUntypedArrowLambda(inner) {
                // Issue #951: defer un-typed arrow lambdas until the static
                // method overload (and its delegate-typed parameters) is known.
                (
                    (
                        if deferredStaticLambdaIndices == nil {
                            (deferredStaticLambdaIndices = List[int32]())
                        } else {
                            deferredStaticLambdaIndices
                        }
                    )!!
                ).Add(staticArgIndex)
                boundArgument = BoundErrorExpression(inner)
            }
            if boundArgument == nil {
                boundArgument = BindExpression(inner)
            }
            boundArguments.Add(boundArgument)
            staticArgIndex++
        }
        var arguments = boundArguments.ToImmutable()
        // Issue #940: resolve static (shared) method overloads against the FULL
        // method group by arity, parameter types, and ref-kinds — identical to
        // the instance-method path — instead of taking the first by-name match
        // and arity-checking it (which rejected every overload but the first,
        // surfacing GS0144). The group is obtained through the ADR-0112
        // canonical member-resolution layer; OverloadResolver selects the best
        // candidate (and reports ambiguity / no-applicable-overload exactly as
        // for instance methods). A single-candidate group is returned unchanged
        // so the legacy per-position arity/optional/variadic diagnostics below
        // still apply (e.g. genuine arity mismatch on a non-overloaded method).
        let staticMethodGroup = TypeMemberModel.GetMethods(
            ownerType,
            methodName,
            if structSym != nil {
                MemberQuery.InheritedStatic(MemberKinds.Method)
            } else {
                MemberQuery.Static(MemberKinds.Method)
            }
        )
        if !staticMethodGroup.IsDefaultOrEmpty {
            let selectionGroup = BuildConstructedStaticOverloadGroup(
                structSym,
                staticMethodGroup,
                out var originalMethods
            )
            var method FunctionSymbol? = overloads.SelectInstanceOverloadOrReport(
                selectionGroup,
                arguments,
                ce,
                methodName,
                argumentNames
            )
            if method == nil {
                return BoundErrorExpression(nil)
            }
            if originalMethods != nil && originalMethods.TryGetValue(method, out var originalMethod) {
                method = originalMethod
            }
            let effectiveOwnerType = if structSym != nil && method!!.StaticOwnerType is StructSymbol declaredOwner {
                cast[TypeSymbol](TypeMemberModel.ResolveStaticMemberOwner(structSym, declaredOwner))
            } else {
                ownerType
            }
            let effectiveStructOwner = effectiveOwnerType as StructSymbol
            let effectiveInterfaceOwner = effectiveOwnerType as InterfaceSymbol
            let ownerDefinition TypeSymbol? = if effectiveStructOwner?.Definition is {} structDefinition {
                cast[TypeSymbol?](structDefinition)
            } else {
                (effectiveInterfaceOwner?.Definition as TypeSymbol?)
            }
            let ownerDefTypeParameters = effectiveStructOwner
                ?.Definition
                ?.TypeParameters ??
                effectiveInterfaceOwner
                ?.Definition
                ?.TypeParameters ??
                ImmutableArray[TypeParameterSymbol].Empty
            let ownerTypeArguments = effectiveStructOwner?.TypeArguments ??
                effectiveInterfaceOwner?.TypeArguments ??
                ImmutableArray[TypeSymbol].Empty
            // Issue #2071: enforce `protected`/`private` accessibility on static
            // (`shared`) method calls, mirroring the instance-call check in
            // OverloadResolver.BindUserInstanceCall (#950/#2044/#2058). Static
            // methods carry their declaring type via StaticOwnerType (they have
            // no receiver), unlike instance methods which use ReceiverType.
            if method!!.StaticOwnerType is StructSymbol methodDeclaringType && !AccessibilityChecker.IsAccessible(
                method!!.Accessibility,
                methodDeclaringType,
                function
            ) {
                Diagnostics.ReportMemberInaccessible(
                    ce.Identifier.Location,
                    method!!.Name,
                    methodDeclaringType.Name,
                    method!!.Accessibility
                )
            }
            // Issue #951: bind any deferred un-typed arrow lambda against the
            // selected static method's delegate-typed parameter so its omitted
            // parameter type(s) and inferred return type are filled in from the
            // parameter shape. Static (`shared`) methods carry no receiver
            // parameter, so the argument index maps directly to the parameter
            // index. A non-delegate parameter leaves the lambda deferred; it is
            // then bound with no target (surfacing GS0304).
            if deferredStaticLambdaIndices != nil {
                let rebound = arguments.ToBuilder()
                for idx in deferredStaticLambdaIndices {
                    if !(rebound[idx] is BoundErrorExpression{Syntax: LambdaExpressionSyntax staticLambda}) {
                        continue
                    }
                    if idx < method!!.Parameters.Length && MemberLookup.TryGetLambdaTargetFunctionTypeFromSymbol(
                        method!!.Parameters[idx].Type,
                        out var staticTarget
                    ) &&
                        staticTarget != nil {
                        rebound[idx] = lambdas.BindLambdaExpression(staticLambda, staticTarget)
                    } else {
                        rebound[idx] = lambdas.BindLambdaExpression(staticLambda)
                    }
                }
                arguments = rebound.ToImmutable()
            }
            // ADR-0101 follow-up / issue #812: a user-declared static method
            // may declare a trailing variadic parameter. Allow flexible
            // arity, infer the element type from trailing args (if generic),
            // and pack / pass-through trailing args into a single slice
            // argument before the per-position conversion loop.
            let isVariadic = method!!
                .Parameters
                .Length > 0 &&
                method!!
                .Parameters[method!!.Parameters.Length - 1]
                .IsVariadic
            let fixedParamCount = if isVariadic {
                method!!.Parameters.Length - 1
            } else {
                method!!.Parameters.Length
            }
            let methodParameterNameAt(int32) -> string = (parameterIndex int32) -> method!!
                .Parameters[parameterIndex]
                .Name
            let methodParameterIsOptional(int32) -> bool = (parameterIndex int32) -> method!!
                .Parameters[parameterIndex]
                .HasExplicitDefaultValue
            // ADR-0063 / issue #936: count the leading non-optional parameters.
            // A static (`shared`) call may omit any trailing parameter that
            // declares a default value, mirroring the instance-call path in
            // OverloadResolver. Omitted slots are synthesized below from each
            // parameter's captured default constant.
            var requiredParamCount = method!!.Parameters.Length
            for var i = method!!.Parameters.Length - 1; i >= 0; i-- {
                if method!!.Parameters[i].HasExplicitDefaultValue {
                    requiredParamCount = i
                } else {
                    break
                }
            }
            var requiredFixedParamCount = fixedParamCount
            while requiredFixedParamCount > 0 &&
                method!!
                .Parameters[requiredFixedParamCount - 1]
                .HasExplicitDefaultValue {
                requiredFixedParamCount--
            }
            if isVariadic {
                if arguments.Length < requiredFixedParamCount {
                    Diagnostics.ReportTooFewArgumentsForVariadic(
                        ce.Location,
                        method!!.Name,
                        requiredFixedParamCount,
                        arguments.Length
                    )
                    return BoundErrorExpression(nil)
                }
            } else if arguments.Length < requiredParamCount || arguments.Length > method!!.Parameters.Length {
                Diagnostics.ReportWrongArgumentCount(
                    ce.Location,
                    method!!.Name,
                    method!!.Parameters.Length,
                    arguments.Length
                )
                return BoundErrorExpression(nil)
            }
            if isVariadic && !overloads.ValidateExpandedVariadicNamedArguments(
                argumentNames,
                fixedParamCount,
                methodParameterNameAt,
                method!!.Name,
                ce
            ) {
                return BoundErrorExpression(nil)
            }
            var parameterSyntax[]ExpressionSyntax?
            if !argumentNames.IsDefault && !isVariadic {
                if !overloads.TryReorderUserCallArguments(
                    ce.Arguments,
                    arguments,
                    method!!.Parameters.Length,
                    methodParameterNameAt,
                    methodParameterIsOptional,
                    method!!.Name,
                    out parameterSyntax,
                    out arguments
                ) {
                    return BoundErrorExpression(nil)
                }
                let filledArguments = arguments.ToBuilder()
                for var i = 0; i < filledArguments.Count; i++ {
                    filledArguments[i] ??= OverloadResolver.CreateOptionalUserDefaultArgument(method!!.Parameters[i])
                }
                arguments = filledArguments.MoveToImmutable()
            } else {
                parameterSyntax = [ce.Arguments.Count]ExpressionSyntax
                for var i = 0; i < ce.Arguments.Count; i++ {
                    parameterSyntax[i] = ce.Arguments[i]
                }
            }
            if isVariadic && arguments.Length < fixedParamCount {
                let padded = ImmutableArray.CreateBuilder[BoundExpression](fixedParamCount)
                padded.AddRange(arguments)
                for var i = arguments.Length; i < fixedParamCount; i++ {
                    padded.Add(OverloadResolver.CreateOptionalUserDefaultArgument(method!!.Parameters[i]))
                }
                arguments = padded.MoveToImmutable()
                Array.Resize(&parameterSyntax, fixedParamCount)
            }
            // Issue #1379: a `shared` (static) method on a generic user type may
            // reference the type's own type parameter(s) in its return type
            // and/or parameter types (`func Make(v T) Box[T]`). When the receiver
            // is a closed construction (`Box[int32]`), seed the substitution map
            // with the struct's type parameters -> the construction's type
            // arguments so the call's return (and parameter) types are surfaced
            // closed (`Box[int32]`), not the raw/open form (which fails the
            // conversion to the closed type, GS0155). This is the user-defined
            // counterpart of the imported-generic fix in issue #1216 and exercises
            // the binding receiver added in issue #1323.
            var substitution Dictionary[TypeParameterSymbol, TypeSymbol]? = nil
            if ownerDefinition != nil && !object.ReferenceEquals(ownerDefinition, ownerType) &&
                !ownerTypeArguments.IsDefaultOrEmpty &&
                !ownerDefTypeParameters
                .IsDefaultOrEmpty {
                substitution = Dictionary[TypeParameterSymbol, TypeSymbol]()
                let defParams = ownerDefTypeParameters
                let count = Math.Min(defParams.Length, ownerTypeArguments.Length)
                for var i = 0; i < count; i++ {
                    substitution[defParams[i]] = ownerTypeArguments[i]
                }
            }
            // Issue #312 / ADR-0020: resolve a generic static method's own type
            // arguments from an explicit `[T1, T2]` list at the call site or by
            // left-to-right inference from argument types.
            if method!!.IsGeneric {
                substitution ??= Dictionary[TypeParameterSymbol, TypeSymbol]()
                if ce.TypeArgumentList != nil {
                    let explicitArgs = ce.TypeArgumentList.Arguments
                    if explicitArgs.Count != method!!.TypeParameters.Length {
                        Diagnostics.ReportWrongTypeArgumentCount(
                            ce.TypeArgumentList.Location,
                            method!!.Name,
                            method!!.TypeParameters.Length,
                            explicitArgs.Count
                        )
                        return BoundErrorExpression(nil)
                    }
                    for var i = 0; i < explicitArgs.Count; i++ {
                        let ta TypeSymbol? = bindTypeClause(explicitArgs[i])
                        if ta == nil {
                            return BoundErrorExpression(nil)
                        }
                        substitution!![method!!.TypeParameters[i]] = ta
                    }
                } else {
                    // ADR-0101 follow-up / issue #812: when the static method is
                    // variadic, fixed parameters infer pairwise as before;
                    // for the variadic slot, infer the element type from each
                    // trailing argument. A single trailing `[]U` arg with
                    // pass-through inference still infers `T=U`.
                    let inferenceLimit = if isVariadic {
                        fixedParamCount
                    } else {
                        arguments.Length
                    }
                    for var i = 0; i < inferenceLimit; i++ {
                        Binder.InferTypeArguments(
                            method!!.Parameters[i].Type,
                            RefCapabilities.GetInferenceType(method!!.Parameters[i], arguments[i].Type),
                            substitution!!
                        )
                    }
                    if isVariadic {
                        let variadicParam = method!!.Parameters[method!!.Parameters.Length - 1]
                        let variadicElementType = VariadicCarriers.GetElementType(variadicParam.Type)
                        let trailingCount = arguments.Length - fixedParamCount
                        if trailingCount == 1 && RefCapabilities.GetValueArgumentInferenceType(
                            arguments[fixedParamCount].Type
                        ) is SliceTypeSymbol singleSlice {
                            Binder.InferTypeArguments(variadicElementType, singleSlice.ElementType, substitution!!)
                        } else {
                            for var i = fixedParamCount; i < arguments.Length; i++ {
                                Binder.InferTypeArguments(
                                    variadicElementType,
                                    RefCapabilities.GetValueArgumentInferenceType(arguments[i].Type),
                                    substitution!!
                                )
                            }
                        }
                    }
                    for tp in method!!.TypeParameters {
                        if !substitution!!.ContainsKey(tp) {
                            Diagnostics.ReportTypeArgumentInferenceFailed(
                                ce.Identifier.Location,
                                method!!.Name,
                                tp.Name
                            )
                            return BoundErrorExpression(nil)
                        }
                    }
                }
                let constraintLocation = if ce.TypeArgumentList != nil {
                    ce.TypeArgumentList.Location
                } else {
                    ce.Identifier.Location
                }
                for tp in method!!.TypeParameters {
                    let typeArg = substitution!![tp]
                    if !Binder.SatisfiesConstraint(typeArg, tp, substitution) {
                        Diagnostics.ReportTypeArgumentDoesNotSatisfyConstraint(
                            constraintLocation,
                            tp.Name,
                            typeArg,
                            Binder.DescribeConstraint(tp)
                        )
                        return BoundErrorExpression(nil)
                    }
                }
            }
            // ADR-0101 follow-up / issue #812: pack / pass-through for the
            // variadic slot. A single trailing arg whose type already equals
            // the substituted slice type passes through; otherwise wrap the
            // trailing args in a fresh `[]T` slice. Empty trailing => empty
            // slice.
            var permutedArgs ImmutableArray[BoundExpression]
            if isVariadic {
                let variadicParam = method!!.Parameters[method!!.Parameters.Length - 1]
                let sliceType = variadicParam.Type
                let substitutedSlice = if substitution != nil {
                    Binder.SubstituteType(sliceType, substitution, $scope.References!!.MapClrTypeToReferences)
                } else {
                    sliceType
                }
                var hasVariadicErrors = false
                // Issue #1823: route through the #1630 canonical helper so
                // trailing elements get the same per-element coercion applied
                // at every other variadic pack site (previously packed raw,
                // uncoerced elements here). Coerce against the SUBSTITUTED
                // slice's element type since generic type arguments may have
                // been inferred/substituted above.
                let variadicArgumentLocation(int32) -> TextLocation = (i int32) -> if i < ce.Arguments.Count {
                    ce.Arguments[i].Location
                } else {
                    ce.Identifier.Location
                }
                permutedArgs = OverloadResolver.PackOrPassThroughVariadicArguments(
                    conversions,
                    Diagnostics,
                    ce,
                    arguments,
                    fixedParamCount,
                    substitutedSlice,
                    variadicParam.Name,
                    variadicArgumentLocation,
                    &hasVariadicErrors
                )
                if hasVariadicErrors {
                    return BoundErrorExpression(nil)
                }
            } else {
                // ADR-0063 / issue #936: pad any trailing optional parameters
                // the static call omitted with their captured default values so
                // the per-position conversion loop binds the full parameter
                // list (matching instance-method behavior).
                if arguments.Length < method!!.Parameters.Length {
                    let padded = ImmutableArray.CreateBuilder[BoundExpression](method!!.Parameters.Length)
                    padded.AddRange(arguments)
                    for var i = arguments.Length; i < method!!.Parameters.Length; i++ {
                        padded.Add(OverloadResolver.CreateOptionalUserDefaultArgument(method!!.Parameters[i]))
                    }
                    permutedArgs = padded.MoveToImmutable()
                } else {
                    permutedArgs = arguments
                }
            }
            let convertedArgs = ImmutableArray.CreateBuilder[BoundExpression](permutedArgs.Length)
            for var i = 0; i < permutedArgs.Length; i++ {
                let paramType = method!!.Parameters[i].Type
                // ADR-0060 / issue #1139: an inline-decl `out var n` / `out let
                // n` / `out _` was bound with TypeSymbol.Error in the first
                // pass (before the static method was resolved) and never
                // declared a local. Now that overload resolution has chosen the
                // method — and the method type-argument substitution is known —
                // re-bind it (via the shared helper used by the instance path)
                // so the synthesized local is typed from the resolved
                // (substituted) out-parameter pointee type and leaks into the
                // enclosing block scope. The out-var arg always sits in the
                // fixed-parameter region, so permutedArgs[i] / ce.Arguments[i] /
                // method.Parameters[i] line up. This must run BEFORE the
                // open-type-parameter shortcut so generic static out-parameters
                // (`func G[T](out r T)`) are handled too.
                let slotSyntax ExpressionSyntax? = if i < parameterSyntax.Length {
                    parameterSyntax[i]
                } else {
                    default(ExpressionSyntax?)
                }
                let substitutedPointeeType = if substitution != nil {
                    Binder.SubstituteType(paramType, substitution, $scope.References!!.MapClrTypeToReferences)
                } else {
                    paramType
                }
                let reboundOutVar BoundExpression? = TryRebindInlineOutVarPlaceholder(
                    permutedArgs[i],
                    slotSyntax,
                    method!!.Parameters[i],
                    substitutedPointeeType
                )
                if reboundOutVar != nil {
                    convertedArgs.Add(reboundOutVar)
                    continue
                }
                // Issue #1379: a parameter typed by the GENERIC STRUCT's own type
                // parameter (`func Make(v T)` on `Box[T]`) is substituted to the
                // closed receiver type argument (`int32`) so the argument is
                // converted to the concrete type. A parameter typed by an
                // unsubstituted (method) type parameter still passes through.
                if paramType is TypeParameterSymbol typeParamParam &&
                    (substitution == nil || !substitution.ContainsKey(typeParamParam)) {
                    convertedArgs.Add(permutedArgs[i])
                    continue
                }
                if substitution != nil &&
                    paramType is FunctionTypeSymbol openFunctionParameter &&
                    LambdaBinder
                    .TryGetFunctionLiteral(permutedArgs[i], out var functionLiteralArgument) {
                    // ADR-0087 §3 R6: substitute the open target before
                    // routing through the adapter. When the substituted
                    // target matches the literal's declared shape the
                    // adapter returns the literal unchanged (see
                    // IsIdentityAdapter), so the emitted MethodDef carries
                    // the literal's concrete signature and the reified
                    // Func/Action TypeSpec at the call site dispatches
                    // through real Invoke without DynamicInvoke marshalling.
                    let substitutedOpenTarget = (
                        Binder.SubstituteType(
                            openFunctionParameter,
                            substitution,
                            $scope.References!!.MapClrTypeToReferences
                        ) as FunctionTypeSymbol
                    ) ??
                        openFunctionParameter
                    convertedArgs.Add(
                        lambdas.CreateErasedFunctionLiteralAdapter(functionLiteralArgument!!, substitutedOpenTarget)
                    )
                    continue
                }
                let expectedType = if substitution != nil {
                    Binder.SubstituteType(paramType, substitution, $scope.References!!.MapClrTypeToReferences)
                } else {
                    paramType
                }
                let argLoc = if i < parameterSyntax.Length {
                    parameterSyntax[i]?.Location ?? ce.Location
                } else {
                    ce.Location
                }
                let lambdaSyntax = if slotSyntax is {} sourceArgument {
                    OverloadResolver.GetLambdaArgumentSyntax(sourceArgument)
                } else {
                    default(LambdaExpressionSyntax?)
                }
                // Issue #4400: an `in` delegate parameter target-types a lambda
                // like a by-value one; the post-pass below passes it by reference.
                if (method!!.Parameters[i].RefKind is RefKind.None or RefKind.In) &&
                    overloads
                    .TryConvertLambdaArgumentWithTarget(
                    permutedArgs[i],
                    expectedType,
                    argLoc,
                    out var targetTypedLambda,
                    lambdaSyntax,
                    method!!.Parameters[i]
                ) {
                    convertedArgs.Add(
                        Invariant.Required(
                            targetTypedLambda,
                            "a successfully target-typed static lambda produces a bound expression",
                            expression: "targetTypedLambda"
                        )
                    )
                    continue
                }
                convertedArgs.Add(
                    conversions.BindCallArgumentWithRefKind(
                        argLoc,
                        permutedArgs[i],
                        expectedType,
                        method!!.Parameters[i],
                        i + 1
                    )
                )
            }
            // Issue #4400: the early `continue`s above (type-parameter
            // pass-through, function-literal adapter, target-typed lambda) never
            // reach BindCallArgumentWithRefKind. Finish any plain value they
            // left at a by-ref slot: an `in` one is passed by readonly
            // reference, a `ref`/`out` one reports GS0235.
            for var i = 0; i < convertedArgs.Count && i < method!!.Parameters.Length; i++ {
                if method!!.Parameters[i].RefKind == RefKind.None {
                    continue
                }
                let byRefType = if substitution != nil {
                    Binder.SubstituteType(
                        method!!.Parameters[i].Type,
                        substitution,
                        $scope.References!!.MapClrTypeToReferences
                    )
                } else {
                    method!!.Parameters[i].Type
                }
                let byRefLocation = if i < parameterSyntax.Length {
                    parameterSyntax[i]?.Location ?? ce.Location
                } else {
                    ce.Location
                }
                convertedArgs[i] = conversions.FinishByRefArgument(
                    convertedArgs[i],
                    method!!.Parameters[i],
                    byRefType,
                    byRefLocation,
                    i + 1
                )
            }
            // Issue #1209: when the static call dispatches on a constructed
            // generic user type, carry the construction so the emitter parents
            // the call at the construction's TypeSpec (a bare MethodDef token is
            // invalid for a method of a generic type). Null for non-generic
            // receivers leaves the ordinary MethodDef path unchanged.
            // Issue #1433: the same parenting requirement applies to a
            // constructed generic INTERFACE owner; it is carried separately
            // because the emitter resolves interface- and struct-declared
            // statics through different TypeSpec helpers.
            let staticGenericOwner = if effectiveStructOwner?.Definition != nil {
                effectiveStructOwner
            } else {
                default(StructSymbol?)
            }
            let staticGenericInterfaceOwner = if effectiveInterfaceOwner?.Definition != nil {
                effectiveInterfaceOwner
            } else {
                default(InterfaceSymbol?)
            }
            // Issue #1931: stash the method's own (explicit or inferred) type
            // arguments on the bound node so the emitter's MethodSpec
            // construction can use this authoritative bind-time result
            // instead of re-deriving it via structural unification (which
            // can fail for uninformative argument shapes like a bare `nil`).
            var methodTypeArguments = default(ImmutableArray[TypeSymbol])
            if method!!.IsGeneric && substitution != nil {
                let methodTypeArgsBuilder = ImmutableArray.CreateBuilder[TypeSymbol](method!!.TypeParameters.Length)
                for tp in method!!.TypeParameters {
                    methodTypeArgsBuilder.Add(substitution[tp])
                }
                methodTypeArguments = methodTypeArgsBuilder.MoveToImmutable()
            }
            let finalArguments = overloads.PreserveNamedArgumentEvaluationOrder(
                ce.Arguments,
                convertedArgs.ToImmutable(),
                methodParameterNameAt
            )
            let MakeStaticGenericCall = func (substitutedReturnOverride TypeSymbol?) BoundCallExpression {
                let result = BoundCallExpression(
                    ce,
                    method!!,
                    finalArguments,
                    substitutedReturnOverride ?? method!!.Type
                ){
                    StaticGenericOwnerType = staticGenericOwner,
                    StaticGenericInterfaceOwnerType = staticGenericInterfaceOwner,
                    MethodTypeArguments = methodTypeArguments
                }
                RecordStaticTypeQualifier(result, ownerType, ce)
                return result
            }
            if substitution != nil {
                var substitutedReturn = Binder.SubstituteType(
                    method!!.Type,
                    substitution,
                    $scope.References!!.MapClrTypeToReferences
                )
                if method!!.IsAsync && !method!!.IsAsyncVoid && !isAsyncIteratorReturnType(method!!.Type) {
                    substitutedReturn = lambdas.WrapAsTask(substitutedReturn, method!!.AsyncReturnsValueTask)
                    return MakeStaticGenericCall(substitutedReturn)
                }
                if method!!.IsSuspending {
                    return CompleteSuspendingCall(
                        MakeStaticGenericCall(lambdas.WrapAsTask(substitutedReturn, useValueTask: true)),
                        substitutedReturn,
                        ce.Location,
                        method!!.Name
                    )
                }
                if !object.ReferenceEquals(substitutedReturn, method!!.Type) {
                    return MakeStaticGenericCall(substitutedReturn)
                }
            }
            if method!!.IsAsync && !method!!.IsAsyncVoid && !isAsyncIteratorReturnType(method!!.Type) {
                let asyncReturn = lambdas.WrapAsTask(method!!.Type, method!!.AsyncReturnsValueTask)
                return MakeStaticGenericCall(asyncReturn)
            }
            // ADR-0174 D4: a suspending static method's call is typed ValueTask[R]; the caller sees R.
            if method!!.IsSuspending {
                return CompleteSuspendingCall(
                    MakeStaticGenericCall(lambdas.WrapAsTask(method!!.Type, useValueTask: true)),
                    method!!.Type,
                    ce.Location,
                    method!!.Name
                )
            }
            return MakeStaticGenericCall(nil)
        }
        if (ownerType is StructSymbol || ownerType is InterfaceSymbol) &&
            TryBindUserCallableMemberInvocation(
            receiver: nil,
            ownerType,
            methodName,
            arguments,
            ce,
            isStatic: true,
            out var delegateMemberCall
        ) {
            return delegateMemberCall!!
        }
        let inheritedImportedType = if structSym == nil {
            default(TypeSymbol?)
        } else {
            TypeMemberModel.GetNearestImportedBase(structSym)
        }
        if inheritedImportedType?.ClrType is Type {
            let imported = CreateInheritedImportedClassSymbol(inheritedImportedType!!, ce)
            return BindAccessorCall(receiver: nil, imported, ce)
        }
        Diagnostics.ReportUnableToFindMember(ce.Location, methodName)
        return BoundErrorExpression(nil)
    }

    shared {
        /// Issue #1069: returns the enclosing (containing) type of a user-defined
        /// nested type symbol, or `null` for a top-level type or a
        /// kind that cannot be nested.
        private func GetSymbolContainingType(type TypeSymbol) TypeSymbol? -> switch type {
            case s is StructSymbol: s.ContainingType
            case e is EnumSymbol: e.ContainingType
            case i is InterfaceSymbol: i.ContainingType
            default: default(TypeSymbol?)
        }

        /// Issue #2203: returns the dotted package name a user-defined aggregate
        /// type was declared in, or `null` for a kind that has no
        /// package (or isn't a user aggregate type at all).
        private func GetSymbolPackageName(type TypeSymbol) string? -> switch type {
            case s is StructSymbol: s.PackageName
            case e is EnumSymbol: e.PackageName
            case i is InterfaceSymbol: i.PackageName
            default: default(string?)
        }

        /// Issue #1069: a user-defined aggregate type (class/struct, enum, or
        /// interface) declared in the current compilation, as opposed to an imported
        /// CLR type or a predefined primitive alias.
        private func IsUserAggregateType(type TypeSymbol) bool -> type is StructSymbol ||
            type is EnumSymbol ||
            type is InterfaceSymbol

        /// Issue #1069: returns the leftmost identifier of an accessor-chain segment
        /// (the head of a call, index, accessor, or bare name), used to detect when a
        /// qualified reference targets a nested type by its simple name.
        private func TryGetHeadIdentifier(
            expression ExpressionSyntax?,
            @NotNullWhen(true) out identifier string?
        ) bool {
            switch expression {
                case name is NameExpressionSyntax {
                    identifier = name.IdentifierToken.ValueText
                    return true
                }
                case call is CallExpressionSyntax {
                    identifier = call.Identifier.ValueText
                    return true
                }
                case accessor is AccessorExpressionSyntax {
                    return TryGetHeadIdentifier(accessor.LeftPart, out identifier)
                }
                case index is IndexExpressionSyntax {
                    return TryGetHeadIdentifier(index.Target, out identifier)
                }
                case structLiteral is StructLiteralExpressionSyntax {
                    identifier = structLiteral.TypeIdentifier.ValueText
                    return true
                }
                case objectCreation is ObjectCreationExpressionSyntax {
                    return TryGetHeadIdentifier(objectCreation.Target, out identifier)
                }
                case collection is CollectionInitializerExpressionSyntax {
                    return TryGetHeadIdentifier(collection.Target, out identifier)
                }
                default {
                    identifier = nil
                    return false
                }
            }
        }

        /// Issue #942/#1537: returns the leftmost (root) identifier of a candidate
        /// user-type-naming chain — the head of a bare name, generic name,
        /// per-segment index, or accessor — WITHOUT binding any bracketed contents.
        /// Used to gate the nested-type-chain probe on the head naming a user
        /// aggregate TYPE before any bracket is speculatively bound as a type
        /// argument, so a genuine indexer whose index is an identifier
        /// (`xs[i]`) is never probed as a constructed nested type. Mirrors the
        /// shapes accepted by (cref:TryFlattenUserTypeExpressionSegments) so
        /// the gate never rejects a chain the core would otherwise flatten.
        /// @param expr The candidate type-naming expression.
        /// @param headName The resolved root identifier on success.
        /// @param headArity The root segment's explicit arity, or -1 when unspecified.
        /// @returns Whether a root identifier could be extracted.
        private func TryGetUserTypeChainHead(
            expr ExpressionSyntax,
            @NotNullWhen(true) out headName string?,
            out headArity int32
        ) bool {
            switch expr {
                case name is NameExpressionSyntax {
                    headName = name.IdentifierToken.ValueText
                    headArity = -1
                    return true
                }
                case generic is GenericNameExpressionSyntax {
                    headName = generic.Identifier.ValueText
                    headArity = generic.TypeArgumentList.Arguments.Count
                    return true
                }
                case index is IndexExpressionSyntax when !index.IsNullConditional &&
                    index.Target is NameExpressionSyntax indexName {
                    headName = indexName.IdentifierToken.ValueText
                    headArity = index.Indices.Count
                    return true
                }
                case index is IndexExpressionSyntax when !index.IsNullConditional {
                    return TryGetUserTypeChainHead(index.Target, out headName, out headArity)
                }
                case accessor is AccessorExpressionSyntax when !accessor.IsNullConditional {
                    return TryGetUserTypeChainHead(accessor.LeftPart, out headName, out headArity)
                }
                default {
                    headName = nil
                    headArity = -1
                    return false
                }
            }
        }

        /// Issue #2209: recognises a generic-instantiation segment
        /// (`Comparer[int32]`) in the middle of a fully-qualified dotted
        /// namespace/type chain and returns its simple type name and arity. The
        /// parser shapes a single type argument as an (cref:IndexExpressionSyntax)
        /// (target is the bare type name, e.g. `Comparer[int32]`) and multiple
        /// or type-shaped arguments as a (cref:GenericNameExpressionSyntax)
        /// (e.g. `Pair[int32, string]`, `Box[int32?]`). A generic
        /// constructor followed by another access carries the same type arguments
        /// on a (cref:CallExpressionSyntax).
        private func TryGetGenericSegmentNameAndArity(
            segment ExpressionSyntax,
            @NotNullWhen(true) out identifier SyntaxToken?,
            out arity int32
        ) bool {
            switch segment {
                case index is IndexExpressionSyntax {
                    if index.IsNullConditional || index.Target is not NameExpressionSyntax indexName {
                        identifier = nil
                        arity = 0
                        return false
                    }
                    identifier = indexName.IdentifierToken
                    arity = index.Indices.Count
                    return true
                }
                case generic is GenericNameExpressionSyntax {
                    identifier = generic.Identifier
                    arity = generic.TypeArgumentList.Arguments.Count
                    return true
                }
                case CallExpressionSyntax{TypeArgumentList: not nil} call {
                    identifier = call.Identifier
                    arity = call.TypeArgumentList!!.Arguments.Count
                    return true
                }
                default {
                    identifier = nil
                    arity = 0
                    return false
                }
            }
        }

        private func TryGetAccessorChainHead(
            rightPart ExpressionSyntax?,
            @NotNullWhen(true) out headName string?,
            out isCall bool
        ) bool {
            switch rightPart {
                case ce is CallExpressionSyntax when !ce.Identifier.IsMissing {
                    headName = ce.Identifier.ValueText
                    isCall = true
                    return !string.IsNullOrEmpty(headName)
                }
                case ne is NameExpressionSyntax when !ne.IdentifierToken.IsMissing {
                    headName = ne.IdentifierToken.ValueText
                    isCall = false
                    return !string.IsNullOrEmpty(headName)
                }
                case acc is AccessorExpressionSyntax {
                    return TryGetAccessorChainHead(acc.LeftPart, out headName, out isCall)
                }
                case ix is IndexExpressionSyntax {
                    return TryGetAccessorChainHead(ix.Target, out headName, out isCall)
                }
                case objCreate is ObjectCreationExpressionSyntax {
                    return TryGetAccessorChainHead(objCreate.Target, out headName, out isCall)
                }
                case collection is CollectionInitializerExpressionSyntax {
                    return TryGetAccessorChainHead(collection.Target, out headName, out isCall)
                }
                default {
                    headName = nil
                    isCall = false
                    return false
                }
            }
        }

        private func HasUserTypeStaticMember(type TypeSymbol?, headName string, isCall bool) bool {
            if type == nil {
                return false
            }
            if type is InterfaceSymbol interfaceType {
                let fieldOwner = interfaceType.Definition ?? interfaceType
                fieldOwner.EnsureMembersResolved()
                if isCall {
                    return !TypeMemberModel.GetMethods(interfaceType, headName, MemberQuery.Static(MemberKinds.Method))
                        .IsEmpty
                }
                return fieldOwner.GetStaticField(headName) != nil || fieldOwner.Properties.Any(
                    (property PropertySymbol) -> property.IsStatic && !property.IsIndexer && property.Name == headName
                ) ||
                    !TypeMemberModel
                    .GetMethods(interfaceType, headName, MemberQuery.Static(MemberKinds.Method)).IsEmpty
            }
            // ADR-0112: route through the canonical member-resolution layer.
            if isCall {
                return !TypeMemberModel.GetMethods(type, headName, MemberQuery.InheritedStatic(MemberKinds.Method))
                    .IsEmpty ||
                    (
                    type is StructSymbol structType && BinderContext.ClrTypeExposesStaticMember(
                        TypeMemberModel.GetNearestImportedBase(structType)?.ClrType,
                        headName
                    )
                )
            }
            return TypeMemberModel.LookupMember(
                type,
                headName,
                MemberQuery.InheritedStatic(MemberKinds.Field | MemberKinds.Property)
            ) != nil ||
                (
                type is StructSymbol nonCallStructType && BinderContext.ClrTypeExposesStaticMember(
                    TypeMemberModel.GetNearestImportedBase(nonCallStructType)?.ClrType,
                    headName
                )
            )
        }

        /// Issue #1537: flattens the type arguments of a constructed generic
        /// enclosing segment into the outermost-first vector its nested types are
        /// reified over — the segment's own (cref:StructSymbol.EnclosingTypeArguments)
        /// (from levels above it) followed by its own (cref:StructSymbol.TypeArguments).
        /// Returns `default` when the segment carries no type arguments (a
        /// non-generic enclosing type contributes nothing to thread).
        /// @param outerConstructed The constructed (or open) enclosing segment.
        /// @returns The flattened enclosing-argument vector, or `default`.
        private func FlattenConstructedEnclosingArguments(outerConstructed StructSymbol) ImmutableArray[TypeSymbol] {
            let enclosing = outerConstructed.EnclosingTypeArguments
            let own = outerConstructed.TypeArguments
            if enclosing.IsDefaultOrEmpty && own.IsDefaultOrEmpty {
                return default(ImmutableArray[TypeSymbol])
            }
            let builder = ImmutableArray.CreateBuilder[TypeSymbol]()
            if !enclosing.IsDefaultOrEmpty {
                builder.AddRange(enclosing)
            }
            if !own.IsDefaultOrEmpty {
                builder.AddRange(own)
            }
            return builder.ToImmutable()
        }

        private func FlattenCommaList(expr ExpressionSyntax) sequence[ExpressionSyntax] {
            // The parser models `a, b` inside `[...]` as a right-leaning
            // BinaryExpression over comma tokens in some positions; most generic
            // arities used here are single-argument. Yield a single element unless
            // a comma-separated shape is recognised.
            yield expr
        }

        /// ADR-0089 / issue #1030: reshapes a type-name expression (a simple name
        /// such as `int32` or a dotted name such as
        /// `System.Collections.Immutable.ImmutableArray`) into a
        /// (cref:TypeClauseSyntax) so it can be bound by the shared
        /// type-clause binder. Returns `false` for non-type shapes.
        /// @param expr The candidate type expression.
        /// @param typeClause The synthesized type clause on success.
        /// @returns Whether the expression names a type.
        private func TryBuildTypeClauseFromExpression(
            expr ExpressionSyntax,
            @NotNullWhen(true) out typeClause TypeClauseSyntax?
        ) bool {
            typeClause = nil
            if expr is NameExpressionSyntax ne && !ne.IdentifierToken.IsMissing {
                typeClause = TypeClauseSyntax(ne.SyntaxTree, ne.IdentifierToken)
                return true
            }
            // Issue #3658: a type argument written as a dotted name
            // (`ImmutableArray[GSharp.Core.CodeAnalysis.Diagnostic].Empty`) reaches
            // the binder as an accessor chain, not a bare name. Flatten the chain
            // into the type clause's qualifier tokens so it binds exactly as the
            // same spelling does in type position.
            if expr is AccessorExpressionSyntax accessor {
                return TryBuildQualifiedTypeClauseFromAccessor(accessor, out typeClause)
            }
            return false
        }

        /// Issue #3658: flattens a dotted accessor chain whose every segment is a
        /// plain identifier (`A.B.C`) into a qualified
        /// (cref:TypeClauseSyntax). Returns `false` when any segment is
        /// null-conditional or is not a simple name, so genuine value expressions
        /// fall back to ordinary expression binding.
        /// @param accessor The candidate dotted type name.
        /// @param typeClause The synthesized qualified type clause on success.
        /// @returns Whether the accessor chain spells a dotted type name.
        private func TryBuildQualifiedTypeClauseFromAccessor(
            accessor AccessorExpressionSyntax,
            @NotNullWhen(true) out typeClause TypeClauseSyntax?
        ) bool {
            typeClause = nil
            let dots = ImmutableArray.CreateBuilder[SyntaxToken]()
            let segments = ImmutableArray.CreateBuilder[SyntaxToken]()
            if !TryCollectDottedNameSegments(accessor, dots, segments) || segments.Count < 2 {
                return false
            }
            let head = segments[0]
            segments.RemoveAt(0)
            typeClause = TypeClauseSyntax(
                accessor.SyntaxTree,
                openBracketToken: nil,
                lengthToken: nil,
                closeBracketToken: nil,
                head,
                dots.ToImmutable(),
                segments.ToImmutable(),
                typeArgumentOpenBracketToken: nil,
                typeArguments: default(GSharp.Core.CodeAnalysis.Syntax.SeparatedSyntaxList[TypeClauseSyntax]?),
                typeArgumentCloseBracketToken: nil,
                questionToken: nil
            )
            return true
        }

        /// Issue #3658: appends the identifier tokens of a dotted-name expression to
        /// [`segments`](paramref) in source order, and the `.` tokens that
        /// separate them to [`dots`](paramref). The parser nests accessor
        /// chains to the right (`A.B.C` is `A.(B.C)`) in expression
        /// position but to the left elsewhere, so both leanings are walked.
        /// @param expr The candidate dotted name.
        /// @param dots Receives the separating `.` tokens.
        /// @param segments Receives the identifier tokens.
        /// @returns Whether every node in the chain is a plain identifier or a non-null-conditional dot.
        private func TryCollectDottedNameSegments(
            expr ExpressionSyntax,
            dots ImmutableArray[SyntaxToken].Builder,
            segments ImmutableArray[SyntaxToken].Builder
        ) bool {
            switch expr {
                case name is NameExpressionSyntax when !name.IdentifierToken.IsMissing {
                    segments.Add(name.IdentifierToken)
                    return true
                }
                case step is AccessorExpressionSyntax when !step.IsNullConditional {
                    if !TryCollectDottedNameSegments(step.LeftPart, dots, segments) {
                        return false
                    }
                    dots.Add(step.DotToken)
                    return TryCollectDottedNameSegments(step.RightPart, dots, segments)
                }
                default {
                    return false
                }
            }
        }

        private func BuildConstructedStaticOverloadGroup(
            lookupType StructSymbol?,
            methods ImmutableArray[FunctionSymbol],
            out originalMethods Dictionary[FunctionSymbol, FunctionSymbol]?
        ) ImmutableArray[FunctionSymbol] {
            originalMethods = nil
            if lookupType == nil || methods.Length <= 1 {
                return methods
            }
            let builder = ImmutableArray.CreateBuilder[FunctionSymbol](methods.Length)
            for method in methods {
                let owner StructSymbol? = if method.StaticOwnerType is StructSymbol declaredOwner {
                    TypeMemberModel.ResolveStaticMemberOwner(lookupType, declaredOwner)
                } else {
                    default(StructSymbol?)
                }
                if owner == nil || owner.Definition == nil {
                    if !builder.Any((existing FunctionSymbol) -> BoundScope.FunctionSignaturesEqual(existing, method)) {
                        builder.Add(method)
                    }
                    continue
                }
                var changed = false
                let parameters = ImmutableArray.CreateBuilder[ParameterSymbol](method.Parameters.Length)
                for parameter in method.Parameters {
                    let parameterType = owner.SubstituteMemberType(parameter.Type)
                    changed |= !object.ReferenceEquals(parameterType, parameter.Type)
                    let constructedParameter = ParameterSymbol(parameter, parameterType!!, parameter.DeclaringSyntax)
                    if parameter.HasExplicitDefaultValue {
                        constructedParameter.SetExplicitDefaultValue(parameter.ExplicitDefaultValue)
                    }
                    parameters.Add(constructedParameter)
                }
                let returnType = owner.SubstituteMemberType(method.Type)
                changed |= !object.ReferenceEquals(returnType, method.Type)
                if !changed {
                    if !builder.Any((existing FunctionSymbol) -> BoundScope.FunctionSignaturesEqual(existing, method)) {
                        builder.Add(method)
                    }
                    continue
                }
                let constructedMethod = FunctionSymbol(
                    method.Name,
                    parameters.MoveToImmutable(),
                    returnType!!,
                    method.Declaration,
                    method.Package,
                    method.Accessibility
                ){
                    IsStatic = method.IsStatic,
                    StaticOwnerType = owner,
                    TypeParameters = method.TypeParameters,
                    ReturnRefKind = method.ReturnRefKind
                }
                if !builder.Any(
                    (existing FunctionSymbol) -> BoundScope.FunctionSignaturesEqual(existing, constructedMethod)
                ) {
                    originalMethods ??= Dictionary[FunctionSymbol, FunctionSymbol]()
                    originalMethods!!.Add(constructedMethod, method)
                    builder.Add(constructedMethod)
                }
            }
            return builder.ToImmutable()
        }
    }
}
