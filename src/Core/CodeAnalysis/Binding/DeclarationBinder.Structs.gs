// <copyright file="DeclarationBinder.Structs.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Linq
import System.Reflection
import System.Runtime.InteropServices

internal partial class DeclarationBinder {
    /// Validates explicit-layout overlaps once all top-level and nested type bodies are bound.
    /// @param topLevelStructs The compilation's top-level struct and class symbols.
    internal func ReportExplicitLayoutReferenceOverlaps(topLevelStructs IEnumerable[StructSymbol]) {
        for structSymbol in topLevelStructs.Concat(nestedStructShells.Values).Distinct() {
            StructLayoutBinder.ReportReferenceFieldOverlaps(structSymbol, Diagnostics)
        }
    }

    /// Issue #973 (phase 2): binds the body of a previously declared struct/class
    /// shell — its instance fields, primary-constructor parameters, base clause,
    /// and all members — and installs them on [`structSymbol`](paramref).
    /// Re-establishes the type-parameter scope captured at declaration time so
    /// member types can reference the type's own type parameters.
    internal func BindStructDeclarationBody(
        syntax StructDeclarationSyntax,
        $package PackageSymbol,
        structSymbol StructSymbol
    ) {
        let previousTypeParameters = binderCtx.CurrentTypeParameters
        let previousContainingType = binderCtx.CurrentContainingType
        this.binderCtx.CurrentContainingType = structSymbol
        try {
            // Issue #1537: a nested type's members may reference the ENCLOSING
            // type's type parameters (e.g. a field of type `U` inside
            // `Middle[T]` nested in `Outer[U]`). Seed the member-binding scope
            // with every enclosing type parameter (outermost-first, so an inner
            // level shadows an outer one on a name clash) BEFORE the type's own
            // parameters, mirroring CLR nested-generic scoping (ECMA-335
            // §II.10.3.1). The emitter reifies such a nested type over the
            // combined [enclosing, own] parameter list and remaps each reference
            // to the correct VAR ordinal, so these references encode verifiably.
            let enclosingTypeParameters = CollectEnclosingTypeParameters(structSymbol.ContainingType)
            if !structSymbol.TypeParameters.IsDefaultOrEmpty || enclosingTypeParameters.Count > 0 {
                this.binderCtx.CurrentTypeParameters = Dictionary[string, TypeParameterSymbol]()
                for tp in enclosingTypeParameters {
                    binderCtx.CurrentTypeParameters!![tp.Name] = tp
                }
                if !structSymbol.TypeParameters.IsDefaultOrEmpty {
                    for tp in structSymbol.TypeParameters {
                        binderCtx.CurrentTypeParameters!![tp.Name] = tp
                    }
                }
            }
            // Issue #2519: aggregate shells carry bare type parameters so every
            // same-compilation constraint target can be published first.
            // Resolve constraints now, with the declaring shell and all sibling
            // source type shells visible, before binding signatures and members.
            ResolvePartialTypeParameterConstraints(
                syntax.TypeParameterList,
                syntax.PartialTypeParameterLists,
                structSymbol.TypeParameters,
                structSymbol.Name,
                syntax.PartialPartLocations
            )
            BindStructDeclarationBodyCore(syntax, $package, structSymbol)
        } finally {
            this.binderCtx.CurrentTypeParameters = previousTypeParameters
            this.binderCtx.CurrentContainingType = previousContainingType
        }
    }

    /// Issue #950: reports GS0380 for any member declared `protected` when
    /// the enclosing type is not an inheritable `open class`. Structs
    /// (value types) and non-open/sealed classes cannot be derived from, so a
    /// `protected` member there has no meaning. A `protected override`
    /// method, property or event is exempt on a class (issue #4674).
    private func ValidateProtectedMemberPlacement(syntax StructDeclarationSyntax) {
        if syntax.IsClass && (syntax.IsOpen || syntax.IsAbstract) {
            return
        }
        // Issue #4674: an `override` takes its accessibility from the base member
        // it overrides, so `protected override` is legal on a sealed (non-`open`)
        // class — that is how a `sealed class Lowerer : BoundTreeRewriter` keeps
        // overriding the base's protected visitor hooks while staying CLR-sealed.
        // Value types cannot be derived from, so they have no base class members
        // to override and keep the diagnostic.
        let overridesAllowed = syntax.IsClass
        for field in syntax.Fields {
            ReportProtectedToken(field.AccessibilityModifier)
        }
        for method in syntax.Methods {
            if !(overridesAllowed && method.IsOverride) {
                ReportProtectedToken(method.AccessibilityModifier)
            }
        }
        for prop in syntax.Properties {
            if !(overridesAllowed && prop.OverrideModifier != nil) {
                ReportProtectedToken(prop.AccessibilityModifier)
            }
        }
        for evt in syntax.Events {
            if !(overridesAllowed && evt.OverrideModifier != nil) {
                ReportProtectedToken(evt.AccessibilityModifier)
            }
        }
        if !syntax.Constructors.IsDefaultOrEmpty {
            for ctor in syntax.Constructors {
                ReportProtectedToken(ctor.AccessibilityModifier)
            }
        }
        if syntax.SharedBlock != nil {
            for field in syntax.SharedBlock!!.Fields {
                ReportProtectedToken(field.AccessibilityModifier)
            }
            for method in syntax.SharedBlock!!.Methods {
                ReportProtectedToken(method.AccessibilityModifier)
            }
            for prop in syntax.SharedBlock!!.Properties {
                ReportProtectedToken(prop.AccessibilityModifier)
            }
            for evt in syntax.SharedBlock!!.Events {
                ReportProtectedToken(evt.AccessibilityModifier)
            }
        }
    }

    /// Issue #950: reports GS0380 when [`modifier`](paramref) is the
    /// `protected` keyword. Used by callers that have already determined
    /// the surrounding context does not permit `protected`.
    private func ReportProtectedToken(modifier SyntaxToken?) {
        if modifier != nil && modifier.Kind == SyntaxKind.ProtectedKeyword {
            Diagnostics.ReportProtectedRequiresOpenType(modifier.Location)
        }
    }

    /// Issue #950: rejects a top-level declaration marked `protected`.
    /// A top-level type or function has no enclosing type to be inherited, so
    /// `protected` is meaningless there (GS0380).
    internal func ValidateTopLevelProtected(modifier SyntaxToken?) -> ReportProtectedToken(modifier)

    private data struct StructFieldBindingResult(
        Fields ImmutableArray[FieldSymbol].Builder,
        PrimaryConstructorParameters ImmutableArray[ParameterSymbol],
        ConstFields ImmutableArray[FieldSymbol].Builder,
        PendingInstanceInitializers List[(Field FieldSymbol, InitSyntax ExpressionSyntax, FieldType TypeSymbol)],
        PendingConstInitializers List[(Field FieldSymbol, Syntax FieldDeclarationSyntax, FieldType TypeSymbol)],
        PendingStaticFieldInitializers List[(Field FieldSymbol, InitSyntax ExpressionSyntax, FieldType TypeSymbol)],
        PendingSharedConstInitializers List[(Field FieldSymbol, Syntax FieldDeclarationSyntax, FieldType TypeSymbol)],
        PendingZeroValueInstanceFields List[(Field FieldSymbol, Syntax SyntaxNode)],
        PendingZeroValueStaticFields List[(Field FieldSymbol, Syntax SyntaxNode)]
    ) : IEquatable[StructFieldBindingResult] { }

    private data struct StructBaseBindingResult(
        BaseClass StructSymbol?,
        ImportedBaseType TypeSymbol?,
        ImplementedInterfaces ImmutableArray[InterfaceSymbol].Builder,
        ImplementedClrInterfaces ImmutableArray[TypeSymbol].Builder
    ) : IEquatable[StructBaseBindingResult] { }

    private data struct StructMemberBindingContext(
        ExistingNames HashSet[string],
        MethodNames HashSet[string],
        ExplicitInterfaceClauseNames HashSet[string],
        PendingConversionOperators List[
            (
                Syntax FunctionDeclarationSyntax,
                Parameters ImmutableArray[ParameterSymbol],
                ReturnType TypeSymbol,
                Accessibility Accessibility,
                Attributes ImmutableArray[BoundAttribute]
            )
        ]
    ) : IEquatable[StructMemberBindingContext] { }

    private func BindStructDeclarationBodyCore(
        syntax StructDeclarationSyntax,
        $package PackageSymbol,
        structSymbol StructSymbol
    ) {
        // ADR-0122 / issue #1014: an `unsafe class` / `unsafe struct` binds all
        // of its members (field types, method signatures, …) within an unsafe
        // context, so they may use unmanaged raw pointers (`*T`).
        using let unsafeContext = binderCtx.PushUnsafeContext(syntax.IsUnsafe)
        // Issue #950: `protected` is only meaningful on members of an
        // inheritable `open class`. Reject it on members of a non-open class,
        // a struct (value types are not inheritable), or a sealed type before
        // binding the members so the user sees one clean GS0380 diagnostic.
        ValidateProtectedMemberPlacement(syntax)
        let fieldBinding = BindStructFieldsAndPrimaryConstructor(syntax, $package, structSymbol)
        let baseBinding = BindStructBaseAndInterfaces(syntax, structSymbol, fieldBinding)
        let memberBinding = CreateStructMemberBindingContext(structSymbol)
        BindStructInstanceMethods(syntax, $package, structSymbol, baseBinding, memberBinding)
        BindStructProperties(syntax, $package, structSymbol, memberBinding)
        BindStructEvents(syntax, $package, structSymbol, baseBinding, memberBinding)
        BindStructSharedBlock(syntax, $package, structSymbol, fieldBinding, memberBinding)
        RegisterStructConversionOperators($package, structSymbol, memberBinding.PendingConversionOperators)
        RegisterStructDeferredInitializers($package, structSymbol, fieldBinding)
        RegisterStructInterfaceChecks(syntax, structSymbol, baseBinding)
        BindStructFinalMembers(syntax, $package, structSymbol, baseBinding)
    }

    private func BindStructFieldsAndPrimaryConstructor(
        syntax StructDeclarationSyntax,
        $package PackageSymbol,
        structSymbol StructSymbol
    ) StructFieldBindingResult {
        let name = structSymbol.Name
        let seenFieldNames = HashSet[string]()
        let fields = ImmutableArray.CreateBuilder[FieldSymbol]()
        // Phase 3.B.3 sub-step 2: Kotlin-style primary constructor parameters
        // declare fields of the same name + type, in source order, in addition
        // to becoming the ctor's parameters.
        var primaryCtorParameters = ImmutableArray[ParameterSymbol].Empty
        if syntax.PrimaryConstructorParameters is {} primaryConstructorParameters {
            let ctorBuilder = ImmutableArray.CreateBuilder[ParameterSymbol]()
            for paramSyntax in primaryConstructorParameters {
                // ADR-0185: a primary-constructor parameter never comes from
                // the destructured arrow-lambda path.
                let paramName = paramSyntax.Identifier!!.ValueText
                var paramType TypeSymbol? = if paramSyntax.Type is {} paramTypeSyntax {
                    bindTypeClause(paramTypeSyntax)
                } else {
                    TypeSymbol.Error
                }
                if paramType == nil {
                    continue
                }
                // ADR-0101 follow-up / issue #819: variadic primary-constructor
                // parameters promote to a `[]T` auto-field of the same name.
                // Inside the body the parameter is `[]T`; at call sites the
                // trailing arguments are packed by
                // `OverloadResolver.BindConstructorCallExpression`. The
                // structural rules (at-most-one, last position) are validated
                // by `ValidateVariadicParameterShape` after this loop.
                let isVariadic = paramSyntax.IsVariadic
                if isVariadic && paramType != TypeSymbol.Error {
                    paramType = VariadicCarriers.ResolveDeclaredParameterType(paramType)
                }
                if !seenFieldNames.Add(paramName) {
                    Diagnostics.ReportSymbolAlreadyDeclared(paramSyntax.Identifier!!.Location, paramName)
                    continue
                }
                // Issue #367: a by-ref-like (`ref struct`) value cannot live in a
                // field of a non-ref-struct, because the containing instance may
                // be heap-allocated. A primary-constructor parameter materializes
                // a field, so reject it here as well. A `ref struct` may itself
                // hold by-ref-like fields (it is stack-only too), so this is only
                // enforced when the containing type is not a ref struct.
                if !syntax.IsRef && TypeSymbol.IsByRefLike(paramType) {
                    Diagnostics.ReportByRefLikeEscape(
                        paramSyntax.Identifier!!.Location,
                        paramType!!,
                        "be used as the type of field '$paramName'"
                    )
                    continue
                }
                // ADR-0039 §4 / ADR-0058: a managed pointer (*T) cannot be a field type —
                // CLR metadata does not permit ELEMENT_TYPE_BYREF in FieldDef signatures.
                if paramType is ByRefTypeSymbol byRefParamType {
                    Diagnostics.ReportPointerTypeCannotBeFieldType(
                        paramSyntax.Identifier!!.Location,
                        byRefParamType.Name
                    )
                    continue
                }
                // ADR-0060: a primary-constructor parameter materializes a field of the
                // same name; a `ref`/`out`/`in` modifier on that slot is meaningless (the
                // CLR cannot store a managed pointer in a field). Reject early so the
                // user sees one clear diagnostic instead of a downstream emit failure.
                if paramSyntax.HasRefKindModifier {
                    Diagnostics.ReportRefKindOnPrimaryCtorParameter(
                        paramSyntax.RefKindModifier?.Location ?? paramSyntax.Identifier!!.Location,
                        paramName
                    )
                }
                let primaryCtorParam = ParameterSymbol(
                    paramName,
                    paramType!!,
                    isVariadic,
                    declaringSyntax: paramSyntax.Identifier,
                    isScoped: paramSyntax.IsScoped
                )
                DeferParameterDefaultValueBinding(paramSyntax, primaryCtorParam, structSymbol, $package)
                // Issue #1913: primary-constructor parameters can carry
                // `@Attr` annotations same as any other parameter list.
                BindAndAttachParameterAttributes(paramSyntax, primaryCtorParam, isDataPositionalMember: syntax.IsData)
                ctorBuilder.Add(primaryCtorParam)
                // Data-type positional members are CLR properties (matching
                // C# records); their backing fields are synthesized below.
                if !syntax.IsData {
                    fields.Add(
                        FieldSymbol(
                            paramName,
                            paramType!!,
                            Accessibility.Public,
                            isReadOnly: syntax.IsInline,
                            declaration: paramSyntax
                        )
                    )
                }
            }
            // ADR-0101 follow-up / issue #819: at most one variadic primary-ctor
            // parameter (`GS0364`) and it must be the last (`GS0145`). Validation
            // runs over the raw syntax so multi-variadic / non-last variadic
            // signatures still get a diagnostic even when one of the parameters
            // failed type binding above.
            ValidateVariadicParameterShape(syntax.PrimaryConstructorParameters!!)
            primaryCtorParameters = ctorBuilder.ToImmutable()
        }
        // Issue #640: collect instance-field initializer expressions alongside
        // the field declarations so we can bind them later (after the struct
        // symbol exists) and emit them into every constructor body.
        let pendingInstanceInitializers = List[(Field FieldSymbol, InitSyntax ExpressionSyntax, FieldType TypeSymbol)]()
        // Issue #948: const fields declared in the type body are implicitly
        // static literal fields. They are diverted out of the instance field
        // list and bound (folded to a constant) after the struct symbol exists.
        let constFieldsBuilder = ImmutableArray.CreateBuilder[FieldSymbol]()
        let pendingConstInitializers = List[(Field FieldSymbol, Syntax FieldDeclarationSyntax, FieldType TypeSymbol)]()
        // Issue #1070: `shared`-block static field initializers and `shared`/const
        // initializers are also deferred so that ALL of them are bound in a single
        // pass once every static member symbol (static field, const, static
        // property) of the enclosing type exists. Binding them in a scope that
        // exposes those static members makes a field initializer able to reference
        // a sibling `const` or `shared` field regardless of declaration order,
        // matching the static-member visibility a method/constructor body already has.
        let pendingStaticFieldInitializers = List[
            (Field FieldSymbol, InitSyntax ExpressionSyntax, FieldType TypeSymbol)
        ]()
        let pendingSharedConstInitializers = List[
            (Field FieldSymbol, Syntax FieldDeclarationSyntax, FieldType TypeSymbol)
        ]()
        // Issue #3310 / ADR-0159: initializer-less fields of the magic
        // collection types get a synthesized empty-instance initializer
        // (injected through the ordinary #640/#1070 field-initializer
        // machinery), so a bare `var items map[K, V]` field is never null.
        let pendingZeroValueInstanceFields = List[(Field FieldSymbol, Syntax SyntaxNode)]()
        let pendingZeroValueStaticFields = List[(Field FieldSymbol, Syntax SyntaxNode)]()
        for fieldSyntax in syntax.Fields {
            let fieldName = fieldSyntax.Identifier.ValueText
            if !seenFieldNames.Add(fieldName) {
                Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.Identifier.Location, fieldName)
                continue
            }
            let fieldType TypeSymbol? = bindTypeClause(fieldSyntax.Type)
            if fieldType == nil {
                continue
            }
            // Issue #367: a by-ref-like (`ref struct`) value cannot be stored in
            // a field of a non-ref-struct (the containing instance may be boxed
            // or heap-allocated). A `ref struct` is itself stack-only, so it may
            // hold by-ref-like fields; only enforce this for non-ref-structs.
            if !syntax.IsRef && TypeSymbol.IsByRefLike(fieldType) {
                Diagnostics.ReportByRefLikeEscape(
                    fieldSyntax.Identifier.Location,
                    fieldType,
                    "be used as the type of field '$fieldName'"
                )
                continue
            }
            // ADR-0039 §4 / ADR-0058: a managed pointer (*T) cannot be a field type —
            // CLR metadata does not permit ELEMENT_TYPE_BYREF in FieldDef signatures.
            if fieldType is ByRefTypeSymbol byRefFieldType {
                Diagnostics.ReportPointerTypeCannotBeFieldType(fieldSyntax.Identifier.Location, byRefFieldType.Name)
                continue
            }
            let fieldAccessibility = resolveAccessibility(fieldSyntax.AccessibilityModifier)
            // ADR-0122 §10 / issue #1035: a fixed-size buffer field
            // `fixed name [N]T` lays out N inline elements and decays to a
            // `*T` to the first element. It is only legal inside an unsafe
            // context, its element type must be a blittable primitive, and N
            // must be a positive constant (captured by the `[N]T` array type).
            if fieldSyntax.IsFixedBuffer {
                if !binderCtx.InUnsafeContext {
                    Diagnostics.ReportFixedBufferRequiresUnsafeContext(
                        fieldSyntax.FixedKeyword?.Location ?? fieldSyntax.Identifier.Location
                    )
                    continue
                }
                if fieldType is not ArrayTypeSymbol fbArray {
                    Diagnostics.ReportFixedBufferInvalidShape(fieldSyntax.Identifier.Location, fieldName)
                    continue
                }
                let fbElement = fbArray.ElementType
                let fbLength = fbArray.Length
                if fbLength <= 0 {
                    Diagnostics.ReportFixedBufferInvalidLength(fieldSyntax.Identifier.Location, fieldName, fbLength)
                    continue
                }
                if !TryGetFixedBufferElementSize(fbElement, out var fbElemSize) {
                    Diagnostics.ReportFixedBufferElementTypeNotSupported(
                        fieldSyntax.Identifier.Location,
                        fbElement.Name
                    )
                    continue
                }
                let fbBacking = SynthesizeFixedBufferBackingStruct(
                    structSymbol,
                    fieldName,
                    fbElement,
                    fbLength,
                    fbElemSize,
                    $package
                )
                let fbFieldSymbol = FieldSymbol(
                    fieldName,
                    fbBacking,
                    fieldAccessibility,
                    isReadOnly: false,
                    declaration: fieldSyntax
                )
                fbFieldSymbol.SetFixedBuffer(fbElement, fbLength)
                Binder.AttachDocumentation(fbFieldSymbol, fieldSyntax)
                fields.Add(fbFieldSymbol)
                continue
            }
            // Issue #948: a `const` field is a compile-time constant — it is
            // implicitly static and read-only and emitted as a literal field.
            if fieldSyntax.IsConst {
                if fieldType == TypeSymbol.NInt || fieldType == TypeSymbol.NUInt {
                    Diagnostics.ReportConstNativeIntegerNotSupported(
                        fieldSyntax.Identifier.Location,
                        fieldName,
                        fieldType.Name
                    )
                    continue
                }
                let constFieldSymbol = FieldSymbol(
                    fieldName,
                    fieldType,
                    fieldAccessibility,
                    isReadOnly: true,
                    isStatic: true,
                    isConst: true,
                    declaration: fieldSyntax
                )
                Binder.AttachDocumentation(constFieldSymbol, fieldSyntax)
                if !fieldSyntax.Annotations.IsDefaultOrEmpty {
                    constFieldSymbol.SetAttributes(
                        BindAttributes(
                            fieldSyntax.Annotations,
                            AttributeTargetKind.Field,
                            Binder.FieldDeclarationAllowedTargets,
                            "a field declaration",
                            AttributeTargets.Field
                        )
                    )
                }
                if fieldSyntax.Initializer == nil {
                    Diagnostics.ReportConstFieldRequiresInitializer(fieldSyntax.Identifier.Location, fieldName)
                } else {
                    pendingConstInitializers.Add((constFieldSymbol, fieldSyntax, fieldType))
                }
                constFieldsBuilder.Add(constFieldSymbol)
                continue
            }
            let fieldSymbol = FieldSymbol(
                fieldName,
                fieldType,
                fieldAccessibility,
                isReadOnly: syntax.IsInline || fieldSyntax.IsReadOnly,
                declaration: fieldSyntax
            )
            Binder.AttachDocumentation(fieldSymbol, fieldSyntax)
            // Issue #186 / ADR-0047 §3: bind any `@Foo` annotations attached
            // to the field declaration with default target `field` so #175
            // use-site diagnostics (e.g. `@Obsolete`) fire on field reads
            // and writes, and #170-style `CustomAttribute` rows are emitted
            // onto the FieldDef.
            if !fieldSyntax.Annotations.IsDefaultOrEmpty {
                fieldSymbol.SetAttributes(
                    BindAttributes(
                        fieldSyntax.Annotations,
                        AttributeTargetKind.Field,
                        Binder.FieldDeclarationAllowedTargets,
                        "a field declaration",
                        AttributeTargets.Field
                    )
                )
            }
            // Issue #640: remember the initializer syntax for binding after
            // the struct symbol is created (we need the struct in scope for
            // type-correct binding, and the field symbol is needed for keying).
            if fieldSyntax.Initializer != nil {
                pendingInstanceInitializers.Add((fieldSymbol, fieldSyntax.Initializer, fieldType))
            } else if MagicCollectionZeroValue.MightNeedZeroValue(fieldType) {
                // Issue #3310 / ADR-0159 (extended by #3319 for struct-typed
                // fields): a candidate zero-value field. This probe runs
                // during the per-struct field-binding pass, before every
                // sibling struct's OWN fields are necessarily populated, so
                // it deliberately does NOT recurse (see
                // MagicCollectionZeroValue.MightNeedZeroValue) — the real
                // recursive decision (and possible null result) happens in
                // the deferred pass below, once every struct in the
                // compilation has its fields set.
                pendingZeroValueInstanceFields.Add((fieldSymbol, fieldSyntax))
            } else if fieldType is ChannelTypeSymbol {
                // Issue #3310 / ADR-0159 channel carve-out: a bare `chan T`
                // field has no usable default and no auto-created instance.
                Diagnostics.ReportChannelRequiresInitializer(fieldSyntax.Identifier.Location, fieldName, fieldType.Name)
            }
            fields.Add(fieldSymbol)
        }
        // Issue #2363: a `data class`/`data struct` with zero fields is now a
        // supported (if degenerate) declaration — needed for the G# mapping
        // of an empty positional C# record (`record Name()`), and equally for
        // a record whose only body members are contract properties (virtual/
        // override/interface-implementing) that cannot be lifted into fields.
        // Such a type still gets the full synthesized member set (equality,
        // hash, ToString, copy), just with a trivial (always-equal, same
        // fixed hash) leaf-type body (ADR-0029) and no `Deconstruct` (there is
        // nothing to deconstruct). GS0104 is retained for source/API
        // stability but is no longer emitted by this check.
        if syntax.IsInline {
            if syntax.IsData {
                Diagnostics.ReportInlineCannotBeCombinedWithData(
                    syntax.InlineKeyword?.Location ?? syntax.Identifier.Location
                )
            }
            if syntax.IsOpen {
                Diagnostics.ReportInlineCannotBeCombinedWithOpen(
                    syntax.OpenModifier?.Location ?? syntax.Identifier.Location
                )
            }
            if fields.Count != 1 {
                Diagnostics.ReportInlineStructRequiresExactlyOneField(syntax.Identifier.Location, name, fields.Count)
            }
        }
        return StructFieldBindingResult(
            fields,
            primaryCtorParameters,
            constFieldsBuilder,
            pendingInstanceInitializers,
            pendingConstInitializers,
            pendingStaticFieldInitializers,
            pendingSharedConstInitializers,
            pendingZeroValueInstanceFields,
            pendingZeroValueStaticFields
        )
    }

    private func BindStructBaseAndInterfaces(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        fieldBinding StructFieldBindingResult
    ) StructBaseBindingResult {
        let name = structSymbol.Name
        let fields = fieldBinding.Fields
        let primaryCtorParameters = fieldBinding.PrimaryConstructorParameters
        let constFieldsBuilder = fieldBinding.ConstFields
        // Phase 4 of #141 / ADR-0047 §5: detect the `@Attribute` declaration
        // sugar marker before resolving the base clause so we can tolerate
        // an explicit `: System.Attribute` (redundant restatement) and reject
        // any conflicting explicit base.
        let hasAttributeSugar = HasAttributeSugarMarker(syntax.Annotations)
        // Issue #949 / #973: the struct symbol shell was constructed and
        // registered in scope by DeclareStructShell (phase 1) so it could be
        // referenced as a self type argument in its own base/interface clause
        // and forward-referenced by other user types. Now that the instance
        // fields and primary-constructor parameters have been bound, install
        // them on the shell. The resolved base class — if any — is installed
        // afterwards via SetBaseClass. Genuine self-inheritance (`class A : A`)
        // is rejected explicitly in the base-clause loop below.
        structSymbol.SetInstanceFieldsAndPrimaryConstructorParameters(fields.ToImmutable(), primaryCtorParameters)
        // Phase 3.B.3 sub-step 3 + 3.B.4: resolve the optional `: X, Y, Z` clause.
        // Each identifier is either the (single) base class or an interface
        // implemented by this class. A base class, if present, must be the
        // first identifier. All same-compilation type shells are already
        // declared, and the global binder orders class bodies base-first.
        var baseClassSymbol StructSymbol? = nil
        var importedBaseType TypeSymbol? = nil
        let implementedInterfaces = ImmutableArray.CreateBuilder[InterfaceSymbol]()
        let implementedClrInterfaces = ImmutableArray.CreateBuilder[TypeSymbol]()
        if syntax.HasBaseType {
            // Issue #976: the `: …` clause is bound for both classes and
            // structs. A class may name a single base class plus interfaces; a
            // struct (CLR value type) may name interfaces only — a base class
            // or base struct is rejected below with GS0382.
            {
                let allBaseTypes = ImmutableArray.CreateBuilder[TypeClauseSyntax]()
                if syntax.BaseTypeClauses.Count > 0 {
                    for var bi = 0; bi < syntax.BaseTypeClauses.Count; bi++ {
                        allBaseTypes.Add(syntax.BaseTypeClauses[bi])
                    }
                }
                // Back-compat for older syntax trees that only populated
                // identifier tokens in the base/interface clause.
                if allBaseTypes.Count == 0 && syntax.BaseTypeIdentifier != nil {
                    allBaseTypes.Add(TypeClauseSyntax(syntax.BaseTypeIdentifier.SyntaxTree, syntax.BaseTypeIdentifier))
                    if !syntax.AdditionalBaseTypeIdentifiers.IsDefaultOrEmpty {
                        for token in syntax.AdditionalBaseTypeIdentifiers {
                            if token != nil {
                                allBaseTypes.Add(TypeClauseSyntax(token.SyntaxTree, token))
                            }
                        }
                    }
                }
                for var i = 0; i < allBaseTypes.Count; i++ {
                    let baseTypeSyntax = allBaseTypes[i]
                    let baseName = GetBaseClauseTypeDisplayName(baseTypeSyntax)
                    let baseLocation = baseTypeSyntax.Identifier?.Location ?? syntax.Identifier.Location
                    // Phase 4 of #141: tolerate an explicit `: Attribute` on an
                    // @Attribute-marked class (redundant restatement). The
                    // System.Attribute base is supplied by the emitter.
                    if hasAttributeSugar &&
                        i == 0 &&
                        !baseTypeSyntax.HasTypeArguments &&
                        (baseName == "Attribute" || baseName == "System.Attribute") {
                        continue
                    }
                    let resolved TypeSymbol? = bindTypeClause(baseTypeSyntax)
                    if resolved == nil || resolved == TypeSymbol.Error {
                        continue
                    }
                    if NativeProtocolMetadata.IsProtocol(resolved) {
                        if i == 0 && syntax.HasBaseConstructorArguments {
                            Diagnostics.ReportNativeProtocol(
                                baseLocation,
                                "native protocol claims do not have constructor arguments"
                            )
                        }
                        if structSymbol.NativeProtocols.Contains(resolved) {
                            Diagnostics.ReportNativeProtocol(
                                baseLocation,
                                "duplicate conformance to '${resolved.Name}'"
                            )
                        } else {
                            structSymbol.NativeProtocols = structSymbol.NativeProtocols.Add(resolved)
                        }
                        continue
                    }
                    // Issue #976: a struct (value type) may only list
                    // interfaces. Reject any resolved type that is not an
                    // interface (a user/CLR class or another struct) with a
                    // dedicated diagnostic instead of silently dropping it.
                    if !syntax.IsClass {
                        let resolvedIsInterface = resolved is InterfaceSymbol ||
                            (resolved.ClrType != nil && resolved.ClrType.IsInterface)
                        if !resolvedIsInterface {
                            Diagnostics.ReportStructCannotHaveBaseClass(baseLocation, name, baseName)
                            continue
                        }
                    }
                    if resolved is InterfaceSymbol iface {
                        if iface.IsGenericDefinition {
                            Diagnostics.ReportWrongTypeArgumentCount(
                                baseLocation,
                                baseName,
                                iface.TypeParameters.Length,
                                0
                            )
                            continue
                        }
                        implementedInterfaces.Add(iface)
                        continue
                    }
                    // Imported semantic aggregates still follow CLR inheritance
                    // eligibility and constructor binding, not source `open` policy.
                    if resolved is StructSymbol baseStruct && baseStruct.IsClass && baseStruct.ClrType == nil {
                        // Issue #949: reject genuine self-inheritance
                        // (`class A : A`, or the generic `class A[T] : A[T]`)
                        // where the type names itself as its OWN base class.
                        // This is distinct from — and must not be confused
                        // with — naming the enclosing type as a generic type
                        // ARGUMENT of a base/interface (`class A : Base[A]`,
                        // `class A : IEquatable[A]`), which is legal and is
                        // handled by the branches above / below.
                        if baseStruct == structSymbol || baseStruct.Definition == structSymbol {
                            Diagnostics.ReportClassInheritsFromItself(baseLocation, name)
                            continue
                        }
                        if baseStruct.IsGenericDefinition {
                            Diagnostics.ReportWrongTypeArgumentCount(
                                baseLocation,
                                baseName,
                                baseStruct.TypeParameters.Length,
                                0
                            )
                            continue
                        }
                        if i != 0 {
                            Diagnostics.ReportUnableToFindType(baseLocation, baseName)
                            continue
                        }
                        if hasAttributeSugar {
                            // Phase 4 of #141 / ADR-0047 §5: @Attribute sugar
                            // forces System.Attribute as the base; conflict.
                            Diagnostics.ReportAttributeClassExplicitBase(baseLocation, baseName)
                            continue
                        }
                        if !baseStruct.IsOpen && !baseStruct.IsSealedHierarchy {
                            Diagnostics.ReportBaseClassNotOpen(baseLocation, baseName)
                            continue
                        }
                        baseClassSymbol = baseStruct
                        continue
                    }
                    if resolved.ClrType != nil {
                        let clrType = resolved.ClrType
                        if clrType.IsGenericTypeDefinition {
                            Diagnostics.ReportWrongTypeArgumentCount(
                                baseLocation,
                                baseName,
                                clrType.GetGenericArguments().Length,
                                0
                            )
                            continue
                        }
                        if clrType.IsInterface {
                            implementedClrInterfaces.Add(resolved)
                            continue
                        }
                        if clrType.IsClass && !clrType.IsSealed {
                            if !ImportedAssemblySemantics.IsInheritableClass(clrType) {
                                Diagnostics.ReportBaseClassNotOpen(baseLocation, baseName)
                                continue
                            }
                            if i != 0 {
                                Diagnostics.ReportUnableToFindType(baseLocation, baseName)
                                continue
                            }
                            if hasAttributeSugar {
                                Diagnostics.ReportAttributeClassExplicitBase(baseLocation, baseName)
                                continue
                            }
                            importedBaseType = resolved
                            continue
                        }
                    }
                    Diagnostics.ReportUnableToFindType(baseLocation, baseName)
                }
            }
        }
        // Issue #949: install the resolved base class now that the base-type
        // clause has been bound (the symbol itself was created earlier so it
        // could be referenced as a self type argument in that clause).
        structSymbol.SetBaseClass(baseClassSymbol)
        structSymbol.SetAttributes(
            BindAttributes(
                syntax.Annotations,
                AttributeTargetKind.Type,
                Binder.TypeDeclarationAllowedTargets,
                if syntax.IsClass {
                    "a class declaration"
                } else {
                    "a struct declaration"
                },
                if syntax.IsClass {
                    AttributeTargets.Class
                } else {
                    AttributeTargets.Struct
                }
            )
        )
        // ADR-0093 / issue #759: parse `@StructLayout(LayoutKind.…)` on
        // the type and `@FieldOffset(N)` on each field; write the resolved
        // values onto the struct/field symbols so the emitter can pick
        // the right CLR TypeAttributes flag and emit the matching
        // ClassLayout / FieldLayout rows.
        StructLayoutBinder.ResolveLayoutAndFieldOffsets(structSymbol, Diagnostics)
        if hasAttributeSugar && syntax.IsClass {
            // Phase 4 of #141 / ADR-0047 §5: tag the class so the emitter
            // overrides its CLR base type to System.Attribute.
            structSymbol.SetIsAttributeClass()
        }
        if importedBaseType != nil {
            // Issue #296: record the imported CLR base class so the emitter
            // writes it as the TypeDef base type, chains the generated ctor to
            // the CLR base's parameterless ctor, and member lookup walks into
            // the CLR base for inherited members.
            structSymbol.SetImportedBaseType(importedBaseType)
        }
        // Issue #4143: an attribute class's PRIMARY constructor parameters
        // are validated here, at the declaration, rather than left to fall
        // through to GS0584 at each use site (or GS9998 if nothing catches
        // it at all). Code review (Copilot): `DerivesFromSystemAttribute`
        // alone is NOT reliable here for a NESTED same-compilation base —
        // it reads the base's already-computed `IsAttributeClass`/
        // `ImportedBaseType` flags, which are only set once THAT type's own
        // `BindStructBaseAndInterfaces` has run, and a nested type whose
        // base is a NESTED sibling declared later in the same enclosing
        // body has not run yet at this point (measured: a bad primary
        // parameter on `Outer.Derived(Value Holder) : Outer.Base` compiled
        // clean with no `GS0585` when `Base` was declared after `Derived`
        // inside the same `Outer`).
        // `DerivesFromSystemAttributeDuringDeclaration` closes that gap
        // without `IsAttributeType`'s `bindTypeClause` fallback, which
        // regressed `Issue1244GenericAbstractOverrideBinderTests` when
        // called here (a generic base clause it was never meant to
        // re-resolve outside its own USE-site caller).
        if DerivesFromSystemAttributeDuringDeclaration(structSymbol) {
            ValidateAttributeConstructorParameterTypes(primaryCtorParameters, syntax.Identifier.Location)
        }
        // Issue #306: bind and resolve an explicit base-constructor initializer
        // (`: Base(args)`). The arguments are bound in a scope that exposes the
        // primary-constructor parameters so they can be forwarded to the base.
        if !syntax.IsSynthesizedRichAnonymousObject {
            BindBaseConstructorInitializer(
                syntax,
                structSymbol,
                baseClassSymbol,
                importedBaseType,
                primaryCtorParameters
            )
        }
        // Issue #640 / issue #1070: the deferred instance-field initializer
        // expressions, const-field foldings, and `shared`-block initializers are
        // all bound later in a single consolidated pass (see "Issue #1070:
        // consolidated field-initializer binding" below), once every static
        // member symbol of the enclosing type has been created. That ordering is
        // what lets an initializer reference a sibling `const`/`shared` field
        // regardless of declaration order. Here we only install the const-field
        // SYMBOLS so downstream member signatures can reference them by name.
        if constFieldsBuilder.Count > 0 {
            structSymbol.SetConstFields(constFieldsBuilder.ToImmutable())
        }
        return StructBaseBindingResult(
            baseClassSymbol,
            importedBaseType,
            implementedInterfaces,
            implementedClrInterfaces
        )
    }

    private func CreateStructMemberBindingContext(structSymbol StructSymbol) StructMemberBindingContext {
        // Collect existing member names for duplicate detection across fields,
        // methods, and properties.
        let existingNames = HashSet[string]()
        for f in structSymbol.Fields {
            existingNames.Add(f.Name)
        }
        // ADR-0149: a property/event carrying an explicit-interface qualifier
        // clause (`prop (IFoo) P T`) is exempt from the ordinary "name already
        // declared" collision below — multiple explicit implementations of
        // DIFFERENT interfaces legitimately share the same plain member name
        // (that's the entire point of the clause). Tracks which plain names
        // were added ONLY via an explicit-clause member, so a later NON-clause
        // member (or a clause targeting the SAME interface — see GS0495 in
        // VerifyExplicitInterfaceClauseResolution) still collides normally.
        let explicitInterfaceClauseNames = HashSet[string]()
        // Issue #1640: methods overload by signature, so a same-named method
        // is not itself a duplicate — but a non-method member (property,
        // event, or field) sharing a method's name IS a collision (CS0102).
        // Method names are tracked separately from existingNames so the
        // method-vs-method checks below (including instance-vs-shared/static
        // overload, issue #1147) stay unaffected, while property/event/field
        // checks can still see method names.
        let methodNames = HashSet[string]()
        // Phase 3.B.3 sub-step 2b: bind methods declared inside the class body.
        // Issue #938 / ADR-0079: in-body methods are the canonical declaration
        // site for owned `class` AND owned `struct`/`data struct` instance
        // methods. Each method becomes a FunctionSymbol with
        // ReceiverType = structSymbol; method bodies are bound later by
        // BindProgram by walking StructSymbol.Methods. For value-type receivers
        // the emitter synthesizes a by-ref `this`, identical to the
        // receiver-clause owned-struct method lowering.
        // Issue #1283: in-body user-defined conversion operators
        // (`func operator implicit/explicit (x T) U` declared directly inside a
        // struct/class body) are modelled exactly like the free-function form —
        // a static `op_Implicit` / `op_Explicit` special-name method on the
        // owning type. They are collected here and registered AFTER the
        // shared-block static methods are installed (which replaces the static
        // method table), so an in-body operator coexists with a `shared` block.
        let pendingConversionOperators = List[
            (
                Syntax FunctionDeclarationSyntax,
                Parameters ImmutableArray[ParameterSymbol],
                ReturnType TypeSymbol,
                Accessibility Accessibility,
                Attributes ImmutableArray[BoundAttribute]
            )
        ]()
        return StructMemberBindingContext(
            existingNames,
            methodNames,
            explicitInterfaceClauseNames,
            pendingConversionOperators
        )
    }

    /// ADR-0192: semantic half of the partial-method consistency check.
    /// `PartialMethodMerger` compares the two parts as source text and then
    /// keeps only the implementing part's signature, which is what gets bound
    /// ([`returnType`](paramref), [`methodParameters`](paramref),
    /// [`methodTypeParameters`](paramref)). Identical text is not proof of
    /// an identical signature: each part binds against its own file's imports,
    /// so a name can be unresolved in the declaring file, or resolve to a
    /// different type there. This binds the declaring part's own type-parameter
    /// constraints, return type, parameter types, parameter attributes, and
    /// default values in the declaring file and compares them with the
    /// implementing part's, reporting GS0611 on the first difference
    /// (Copilot review rounds 7, 10 and 12).
    ///
    /// Type clauses bind in their own file through `bindTypeClause`, which
    /// redirects import lookup to the clause's own tree ("Issue #3336");
    /// attributes and deferred defaults do the same by their syntax's tree.
    /// Each comparison is skipped when binding the declaring side already
    /// reported an error — that error names the problem more precisely than a
    /// follow-on GS0611. The declaring side goes through the same post-processing
    /// as the implementing side (async return wrapping, variadic widening), or
    /// every async or variadic pair would compare unequal.
    private func ValidateMergedPartialMethodSignatureBinding(
        methodSyntax FunctionDeclarationSyntax,
        returnType TypeSymbol,
        methodParameters ImmutableArray[ParameterSymbol],
        methodTypeParameters ImmutableArray[TypeParameterSymbol],
        structSymbol StructSymbol,
        $package PackageSymbol
    ) {
        // Skip a pair the syntax-level check already rejected: past that
        // point this check can only cascade (e.g. `Echo[T]` paired with
        // `Echo[U]` binds with only `U` in scope).
        if methodSyntax.DeclaringPart is not{} declaringPart || methodSyntax.PartsDisagreement != nil {
            return
        }
        let methodName = methodSyntax.Identifier.ValueText
        const ResolvesDifferently = "the same spelling resolves differently in the declaring and implementing files"
        let Disagree = func (aspect string) {
            Diagnostics.ReportPartialMethodPartsDisagree(methodSyntax.Identifier.Location, methodName, aspect)
        }
        let BindsCleanly = func (bind() -> void) bool {
            let before = Diagnostics.Count
            bind()
            return !Diagnostics.Skip(before).Any((d Diagnostic) -> d.IsError)
        }
        if declaringPart.TypeParameterList is {} declaringTypeParameterList && !methodTypeParameters.IsDefaultOrEmpty {
            var declaringTypeParameters = ImmutableArray[TypeParameterSymbol].Empty
            if BindsCleanly(
                () -> {
                    declaringTypeParameters = BindTypeParameterList(declaringTypeParameterList)
                }
            ) &&
                !TypeParameterConstraintSignaturesEquivalent(methodTypeParameters, declaringTypeParameters) {
                Disagree("the type parameter constraints ($ResolvesDifferently)")
                return
            }
        }
        // An omitted declaring return type is `void`: the implementing part's
        // omitted type is not always void, since a `-> object { … }` body infers one.
        var declaringReturnType = if declaringPart.Type != nil {
            bindReturnTypeClause(declaringPart.Type, declaringPart.IsAsync) ?? TypeSymbol.Error
        } else {
            TypeSymbol.Void
        }
        if declaringReturnType != TypeSymbol.Error {
            declaringReturnType = NormalizeAsyncDeclaredReturnType(declaringReturnType, declaringPart.IsAsync, out _)
        }
        if declaringReturnType != TypeSymbol.Error &&
            returnType != TypeSymbol.Error &&
            !TypeSignaturesEquivalent(declaringReturnType, returnType) {
            Disagree(
                if declaringPart.Type != nil {
                    "the return type ($ResolvesDifferently)"
                } else {
                    "the return type (the declaring part states none, but the implementing part's body infers '${returnType.Name}')"
                }
            )
            return
        }
        let declaringParameters = declaringPart.Parameters
        for var i = 0; i < declaringParameters.Count && i < methodParameters.Length; i++ {
            let declaringParameterSyntax = declaringParameters[i]
            let implementingParameter = methodParameters[i]
            let parameterNumber = i + 1
            if declaringParameterSyntax.Type is {} declaringParameterTypeSyntax {
                var declaringParameterType = bindTypeClause(declaringParameterTypeSyntax) ?? TypeSymbol.Error
                if declaringParameterType != TypeSymbol.Error && declaringParameterSyntax.IsVariadic {
                    declaringParameterType = VariadicCarriers.ResolveDeclaredParameterType(declaringParameterType)
                }
                if declaringParameterType != TypeSymbol.Error &&
                    implementingParameter.Type != TypeSymbol.Error &&
                    !TypeSignaturesEquivalent(declaringParameterType, implementingParameter.Type) {
                    Disagree("parameter $parameterNumber's type ($ResolvesDifferently)")
                    return
                }
            }
            if !declaringParameterSyntax.Annotations.IsDefaultOrEmpty {
                var declaringAttributes = ImmutableArray[BoundAttribute].Empty
                let implementingAttributes = if implementingParameter.Attributes.IsDefault {
                    ImmutableArray[BoundAttribute].Empty
                } else {
                    implementingParameter.Attributes
                }
                if BindsCleanly(
                    () -> {
                        declaringAttributes = BindAttributes(
                            declaringParameterSyntax.Annotations,
                            AttributeTargetKind.Param,
                            Binder.ParameterAllowedTargets,
                            "a parameter declaration",
                            AttributeTargets.Parameter
                        )
                    }
                ) &&
                    (
                    declaringAttributes.Length != implementingAttributes.Length || declaringAttributes.Zip(
                        implementingAttributes
                    )
                        .Any(
                        (pair(First BoundAttribute, Second BoundAttribute)) -> !BoundAttributesEquivalent(
                            pair.First,
                            pair.Second
                        )
                    )
                ) {
                    Disagree("parameter $parameterNumber's annotations ($ResolvesDifferently)")
                    return
                }
            }
            if declaringParameterSyntax.HasDefaultValue {
                // Defaults bind in a deferred pass once every type's static
                // members exist. Bind the declaring part's default into a
                // stand-in symbol there too, then compare once both are done.
                let declaringDefault = ParameterSymbol(
                    implementingParameter,
                    implementingParameter.Type,
                    declaringParameterSyntax.Identifier
                )
                DeferParameterDefaultValueBinding(
                    declaringParameterSyntax,
                    declaringDefault,
                    structSymbol,
                    $package,
                    methodTypeParameters
                )
                pendingParameterDefaultValueBindings.Add(
                    () -> {
                        if declaringDefault.HasExplicitDefaultValue &&
                            implementingParameter.HasExplicitDefaultValue &&
                            !object
                            .Equals(declaringDefault.ExplicitDefaultValue, implementingParameter.ExplicitDefaultValue) {
                            Disagree("parameter $parameterNumber's default value ($ResolvesDifferently)")
                        }
                    }
                )
            }
        }
    }

    private func BindStructInstanceMethods(
        syntax StructDeclarationSyntax,
        $package PackageSymbol,
        structSymbol StructSymbol,
        baseBinding StructBaseBindingResult,
        memberBinding StructMemberBindingContext
    ) {
        let implementedClrInterfaces = baseBinding.ImplementedClrInterfaces
        let methodNames = memberBinding.MethodNames
        let pendingConversionOperators = memberBinding.PendingConversionOperators
        if !syntax.Methods.IsDefaultOrEmpty {
            let methodsBuilder = ImmutableArray.CreateBuilder[FunctionSymbol]()
            for methodSyntax in syntax.Methods {
                let methodName = methodSyntax.Identifier.ValueText
                // Issue #938 / ADR-0029: inline and data structs synthesize a
                // fixed set of members (Equals, GetHashCode, ToString,
                // op_Equality, op_Inequality, Deconstruct). User code may not
                // hand-write any of them via the in-body form either — this
                // mirrors the receiver-clause guard below so both spellings of
                // an owned-struct instance method reject the same collisions.
                if structSymbol.IsInline && IsInlineSynthesizedMemberName(methodName) {
                    Diagnostics.ReportInlineStructSynthesizedMemberConflict(
                        methodSyntax.Identifier.Location,
                        structSymbol.Name,
                        methodName
                    )
                    continue
                }
                // Issue #2361: a data class/struct's ToString is the one
                // synthesized-name exception — its exact shape is validated a
                // few lines below (once the parameter list/return type are
                // bound), where it either falls through as an ordinary
                // in-body method (suppressing the synthesized ToString) or is
                // rejected with the more specific GS0487. The other five
                // synthesized names stay unconditionally reserved here.
                if structSymbol.IsData &&
                    IsDataStructSynthesizedMemberName(methodName) &&
                    !IsUserOverridableDataMemberName(methodName) {
                    Diagnostics.ReportDataStructSynthesizedMemberConflict(
                        methodSyntax.Identifier.Location,
                        structSymbol.Name,
                        structSymbol.IsClass,
                        methodName
                    )
                    continue
                }
                // ADR-0063: allow same-name overloads on a class body. The duplicate
                // check is replaced by a signature-identity check applied below, after
                // the parameter list has been bound. A name collision with an existing
                // field or non-method member is still rejected here.
                if structSymbol.TryGetField(methodName, out _) {
                    Diagnostics.ReportSymbolAlreadyDeclared(methodSyntax.Identifier.Location, methodName)
                    continue
                }
                // Issue #312 / ADR-0020: a method may declare its own generic
                // type-parameter list (`func M[T](...) T`). Bind it first and
                // seed it into the binding scope — merged with any enclosing
                // class type parameters — so the method's parameter types,
                // return type, and (later) body can reference `T`. The seeding
                // is unwound at the end of each iteration so one method's type
                // parameters never leak into the next or the surrounding type.
                let methodTypeParameters = BindTypeParameterList(methodSyntax.TypeParameterList)
                let enclosingTypeParameters Dictionary[string, TypeParameterSymbol]? = binderCtx.CurrentTypeParameters
                if !methodTypeParameters.IsDefaultOrEmpty {
                    this.binderCtx.CurrentTypeParameters = if enclosingTypeParameters == nil {
                        Dictionary[string, TypeParameterSymbol]()
                    } else {
                        Dictionary[string, TypeParameterSymbol](enclosingTypeParameters)
                    }
                    for tp in methodTypeParameters {
                        binderCtx.CurrentTypeParameters!![tp.Name] = tp
                    }
                }
                try {
                    // ADR-0122 / issue #1036: an `unsafe func` method binds its
                    // SIGNATURE (parameter + return types) in an unsafe context
                    // too — not just its body — so a single unsafe method in an
                    // otherwise-safe type may take/return unmanaged raw pointers
                    // (`*T` → CLR ELEMENT_TYPE_PTR). When the method is not
                    // `unsafe` (and the enclosing type is safe) this is a no-op.
                    using let sigUnsafeContext = binderCtx.PushUnsafeContext(methodSyntax.IsUnsafe)
                    let parameters = ImmutableArray.CreateBuilder[ParameterSymbol]()
                    let seenParameterNames = HashSet[string]()
                    for var pIndex = 0; pIndex < methodSyntax.Parameters.Count; pIndex++ {
                        let parameterSyntax = methodSyntax.Parameters[pIndex]
                        // ADR-0185: a struct method's parameters never come
                        // from the destructured arrow-lambda path.
                        let parameterName = parameterSyntax.Identifier!!.ValueText
                        var parameterType = if parameterSyntax.Type is {} parameterTypeSyntax {
                            bindTypeClause(parameterTypeSyntax) ?? TypeSymbol.Error
                        } else {
                            TypeSymbol.Error
                        }
                        // ADR-0101 follow-up / issue #812: variadic parameters
                        // are now accepted on class instance methods. The body
                        // sees the parameter as a `[]T` slice; the call site
                        // packs trailing arguments into a fresh slice (or
                        // passes through a single `[]T` argument unchanged) —
                        // see OverloadResolver.BindUserInstanceCall.
                        let isVariadic = parameterSyntax.IsVariadic
                        if isVariadic && parameterType != TypeSymbol.Error {
                            parameterType = VariadicCarriers.ResolveDeclaredParameterType(parameterType)
                        }
                        let parameterRefKind = conversions.BindAndValidateParameterRefKind(
                            parameterSyntax,
                            parameterName,
                            parameterType,
                            isVariadic,
                            asyncOrIteratorKind: if methodSyntax.IsAsync {
                                "async"
                            } else {
                                (
                                    if methodSyntax.IsSuspend {
                                        "suspend"
                                    } else {
                                        default(string?)
                                    }
                                )
                            }
                        )
                        // Issue #1262: `_` is the discard identifier — repeated `_` parameters are
                        // permitted on named functions/methods. Each `_` occupies a positional slot
                        // but is not added to the body scope, so non-`_` duplicates still error.
                        if parameterName != "_" && !seenParameterNames.Add(parameterName) {
                            Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName)
                        } else {
                            let classMethodParam = ParameterSymbol(
                                parameterName,
                                parameterType,
                                isVariadic,
                                declaringSyntax: parameterSyntax.Identifier,
                                isScoped: parameterSyntax.IsScoped,
                                refKind: parameterRefKind
                            )
                            DeferParameterDefaultValueBinding(
                                parameterSyntax,
                                classMethodParam,
                                structSymbol,
                                $package,
                                methodTypeParameters
                            )
                            BindAndAttachParameterAttributes(parameterSyntax, classMethodParam)
                            parameters.Add(classMethodParam)
                        }
                    }
                    ValidateVariadicParameterShape(methodSyntax.Parameters)
                    var returnType = BindIteratorReturnType(methodSyntax)
                    let methodAccessibility = resolveAccessibility(methodSyntax.AccessibilityModifier)
                    // ADR-0146 (Kotlin visibility narrowing follow-up): infer/narrow the
                    // return type when the (omitted-type) body is `-> object { ... }`.
                    returnType = InferAnonymousClassLiteralReturnType(methodSyntax, returnType, methodAccessibility)
                    let methodIsAsyncVoid = IsExplicitAsyncVoid(methodSyntax, returnType)
                    returnType = NormalizeAsyncDeclaredReturnType(
                        returnType,
                        methodSyntax.IsAsync,
                        out var returnTypeIsValueTask
                    )
                    let methodParameters = parameters.ToImmutable()
                    let methodReturnRefKind = ValidateReturnRefKind(methodSyntax, returnType)
                    // Copilot review round 7: the declaring part's own
                    // return/parameter type clauses were discarded after
                    // only a textual comparison; bind and compare them
                    // semantically too.
                    ValidateMergedPartialMethodSignatureBinding(
                        methodSyntax,
                        returnType,
                        methodParameters,
                        methodTypeParameters,
                        structSymbol,
                        $package
                    )
                    // Issue #1283: a conversion operator declared in the body is
                    // not an instance method — defer it to the static
                    // `op_Implicit` / `op_Explicit` registration below, reusing
                    // the same machinery as the free-function form so the
                    // conversion is recognised and applied at every target-typed
                    // position.
                    if methodSyntax.IsConversionOperator {
                        var conversionAttributes = ImmutableArray[BoundAttribute].Empty
                        if !methodSyntax.Annotations.IsDefaultOrEmpty {
                            conversionAttributes = BindAttributes(
                                methodSyntax.Annotations,
                                AttributeTargetKind.Method,
                                Binder.FunctionDeclarationAllowedTargets,
                                "a method declaration",
                                AttributeTargets.Method
                            )
                        }
                        pendingConversionOperators.Add(
                            (methodSyntax, methodParameters, returnType, methodAccessibility, conversionAttributes)
                        )
                        continue
                    }
                    // Issue #1071: the effective async flag (mirrors
                    // FunctionSymbol.IsAsync below) so override / shadow matching
                    // compares the async-normalized effective return type.
                    let methodIsAsync = methodSyntax.IsAsync ||
                        (
                        isAsyncIteratorReturnType(returnType) &&
                            methodSyntax.Body is {} methodBody &&
                            IteratorDetection.ContainsYield(methodBody)
                    )
                    // Issue #2361: now that the parameter list/return type are
                    // bound, validate a data class/struct's ToString shape.
                    // Compatible: fall through as an ordinary in-body method
                    // (its FunctionSymbol lands in structSymbol.Methods below,
                    // which both the emitter's method-row planner and
                    // DataStructSynthesizer.EmitDataStructSynthesizedMembers
                    // check to suppress the synthesized ToString row/body).
                    // Incompatible: reject with GS0487 instead of silently
                    // colliding with (or shadowing) the synthesized member.
                    if structSymbol.IsData &&
                        methodName == "ToString" &&
                        !IsCompatibleDataToStringOverride(
                        methodSyntax.Parameters.Count,
                        returnType,
                        methodReturnRefKind,
                        methodIsAsync,
                        methodSyntax.IsUnsafe,
                        methodTypeParameters,
                        methodAccessibility
                    ) {
                        Diagnostics.ReportIncompatibleDataToStringOverride(
                            methodSyntax.Identifier.Location,
                            structSymbol.Name,
                            structSymbol.IsClass
                        )
                        continue
                    }
                    // ADR-0199: a data type's `PrintMembers(StringBuilder)` is the
                    // C# record print slot. A compatible declaration replaces the
                    // synthesized one (the same rule ToString has); any other shape
                    // of that slot is rejected rather than silently shadowing it.
                    if structSymbol.IsData && DataPrintMembersModel.IsSlotCandidate(
                        methodName,
                        methodSyntax.HasExplicitInterfaceClause,
                        methodParameters
                    ) &&
                        !IsCompatibleDataPrintMembers(
                        structSymbol,
                        returnType,
                        methodReturnRefKind,
                        methodIsAsync,
                        methodSyntax.IsSuspend,
                        methodSyntax.IsOverride,
                        methodTypeParameters,
                        methodAccessibility
                    ) {
                        Diagnostics.ReportIncompatibleDataPrintMembers(
                            methodSyntax.Identifier.Location,
                            structSymbol.Name,
                            structSymbol.IsClass,
                            if DataPrintMembersModel.GetRequiredAccessibility(structSymbol) == Accessibility.Private {
                                "private"
                            } else {
                                "protected"
                            }
                        )
                        continue
                    }
                    // Phase 3.B.3 sub-step 3: open/override validation against
                    // base class chain per ADR-0017.
                    var overriddenMethod FunctionSymbol? = nil
                    var externalOverriddenMethod MethodInfo? = nil
                    var externalOverrideContainingType TypeSymbol? = nil
                    if methodSyntax.IsOverride {
                        // ADR-0063 §8: when the base exposes a name-overload set, the
                        // override targets the entry whose signature matches exactly;
                        // an unrelated same-name overload no longer steals the slot.
                        let baseOverloads = structSymbol.BaseClass?.GetMethodsIncludingInherited(methodName) ??
                            ImmutableArray[FunctionSymbol].Empty
                        let baseTypeArgSubst = BuildBaseTypeArgumentSubstitution(structSymbol)
                        var baseMethod FunctionSymbol? = nil
                        var baseSignatureMatch FunctionSymbol? = nil
                        for candidate in baseOverloads {
                            baseMethod ??= candidate
                            let candidateTypeArgSubst = WithMethodTypeParameterSubstitution(
                                baseTypeArgSubst,
                                candidate,
                                methodTypeParameters
                            )
                            if SignaturesMatch(
                                candidate,
                                methodParameters,
                                returnType,
                                methodReturnRefKind,
                                candidateTypeArgSubst,
                                methodIsAsync,
                                methodIsAsyncVoid
                            ) {
                                baseSignatureMatch = candidate
                                break
                            }
                        }
                        if baseMethod == nil {
                            let externalMatch = ExternalClrOverrideResolver.FindMethod(
                                structSymbol,
                                methodName,
                                methodParameters,
                                returnType,
                                methodReturnRefKind,
                                methodTypeParameters,
                                methodAccessibility,
                                methodIsAsync,
                                methodIsAsyncVoid,
                                returnTypeIsValueTask,
                                methodSyntax.IsSuspend,
                                binderCtx.References
                            )
                            if externalMatch.Member != nil {
                                externalOverriddenMethod = externalMatch.Member
                                externalOverrideContainingType = externalMatch.ContainingType
                            } else if externalMatch.IsSealed {
                                Diagnostics.ReportOverrideOfSealedMethod(methodSyntax.Identifier.Location, methodName)
                            } else if externalMatch.SawName {
                                Diagnostics.ReportOverrideSignatureMismatch(
                                    methodSyntax.Identifier.Location,
                                    methodName
                                )
                            } else {
                                Diagnostics.ReportNoBaseMethodToOverride(methodSyntax.Identifier.Location, methodName)
                            }
                        } else if baseSignatureMatch != nil {
                            if !baseSignatureMatch.IsOpen {
                                Diagnostics.ReportOverrideOfSealedMethod(methodSyntax.Identifier.Location, methodName)
                            } else {
                                overriddenMethod = baseSignatureMatch
                            }
                        } else if !baseMethod.IsOpen {
                            Diagnostics.ReportOverrideOfSealedMethod(methodSyntax.Identifier.Location, methodName)
                        } else {
                            // No matching overload signature: surface the most specific
                            // diagnostic against the first (this-first) base overload to
                            // preserve the existing error message shape.
                            if baseMethod.Type == returnType && baseMethod.ReturnRefKind != methodReturnRefKind {
                                Diagnostics.ReportOverrideReturnRefKindMismatch(
                                    methodSyntax.Identifier.Location,
                                    methodName,
                                    RefCapabilities.DescribeReturn(baseMethod.ReturnRefKind),
                                    RefCapabilities.DescribeReturn(methodReturnRefKind)
                                )
                            } else {
                                let refMismatchIdx = FindRefKindMismatchIndex(baseMethod, methodParameters, returnType)
                                if refMismatchIdx >= 0 {
                                    let baseCallable = GetCallableParameters(baseMethod)
                                    Diagnostics.ReportOverrideRefKindMismatch(
                                        methodSyntax.Identifier.Location,
                                        methodName,
                                        methodParameters[refMismatchIdx].Name,
                                        refKindToString(baseCallable[refMismatchIdx].RefKind),
                                        refKindToString(methodParameters[refMismatchIdx].RefKind)
                                    )
                                } else {
                                    Diagnostics.ReportOverrideSignatureMismatch(
                                        methodSyntax.Identifier.Location,
                                        methodName
                                    )
                                }
                            }
                        }
                    } else if structSymbol.BaseClass != nil {
                        // ADR-0063 §8: only diagnose missing-override against a base
                        // overload whose signature is the same as the new declaration.
                        // A new same-name overload that does not match any base entry
                        // is a brand-new overload, not an accidental shadow.
                        let baseOverloads = structSymbol.BaseClass!!.GetMethodsIncludingInherited(methodName)
                        let baseTypeArgSubst = BuildBaseTypeArgumentSubstitution(structSymbol)
                        for shadowed in baseOverloads {
                            if !shadowed.IsOpen {
                                continue
                            }
                            let shadowedTypeArgSubst = WithMethodTypeParameterSubstitution(
                                baseTypeArgSubst,
                                shadowed,
                                methodTypeParameters
                            )
                            if SignaturesMatch(
                                shadowed,
                                methodParameters,
                                returnType,
                                methodReturnRefKind,
                                shadowedTypeArgSubst,
                                methodIsAsync,
                                methodIsAsyncVoid
                            ) {
                                if shadowed.ReceiverType is {} shadowedReceiverType {
                                    Diagnostics.ReportMissingOverride(
                                        methodSyntax.Identifier.Location,
                                        shadowedReceiverType.Name,
                                        methodName
                                    )
                                }
                                break
                            }
                        }
                    }
                    // ADR-0199: a compatible protected print-members slot is always
                    // emitted as an overridable virtual method, so the symbol says so
                    // whatever modifiers the source wrote.
                    let isOpenMethod = methodSyntax.IsOpen ||
                        (
                        structSymbol.IsData &&
                            methodAccessibility == Accessibility.Protected &&
                            DataPrintMembersModel.IsSlotCandidate(
                            methodName,
                            methodSyntax.HasExplicitInterfaceClause,
                            methodParameters
                        )
                    )
                    let methodSymbol = FunctionSymbol(
                        methodName,
                        methodParameters,
                        returnType,
                        methodSyntax,
                        $package,
                        methodAccessibility,
                        receiverType: structSymbol,
                        isOpen: isOpenMethod,
                        isOverride: methodSyntax.IsOverride
                    )
                    methodSymbol.OverriddenMethod = overriddenMethod
                    methodSymbol.ExternalOverriddenMethod = externalOverriddenMethod
                    methodSymbol.ExternalOverrideContainingType = externalOverrideContainingType
                    methodSymbol.TypeParameters = methodTypeParameters
                    methodSymbol.ReturnRefKind = methodReturnRefKind
                    methodSymbol.IsAsync = methodSyntax.IsAsync ||
                        (
                        isAsyncIteratorReturnType(returnType) &&
                            methodSyntax.Body is {} methodBodyForSymbol &&
                            IteratorDetection.ContainsYield(methodBodyForSymbol)
                    )
                    methodSymbol.IsAsyncVoid = methodIsAsyncVoid
                    methodSymbol.SuspendingKind = if methodSyntax.IsSuspend {
                        SuspendingKind.Declared
                    } else {
                        SuspendingKind.None
                    }
                    methodSymbol.AsyncReturnsValueTask = returnTypeIsValueTask || methodSyntax.IsSuspend
                    methodSymbol.IsUnsafe = binderCtx.InUnsafeContext
                    // Issue #2834: an in-body compound-assignment operator
                    // (`public func operator +=(n int32)`) is an ordinary
                    // instance method plus `specialname`, matching the shape
                    // C# 14 emits and consumes for `op_*Assignment`.
                    if OperatorNames.IsCompoundAssignmentName(methodName) {
                        methodSymbol.IsSpecialName = true
                        ValidateCompoundAssignmentOperatorShape(
                            methodSyntax,
                            methodName,
                            returnType,
                            methodParameters.Length
                        )
                    }
                    // Issue #987: a no-body `open func F() R;` inside a class is
                    // the canonical G# spelling of a C# abstract method. Mark the
                    // method abstract so the body binder skips it (there is no
                    // body to bind) and the emitter writes an abstract virtual
                    // slot rather than crashing on a null body. The bodyless form
                    // is only valid as an `open` member of an `open` class — any
                    // other shape (a non-`open` bodyless method, or one inside a
                    // non-`open` class) is reported with GS0388.
                    Binder.AttachDocumentation(methodSymbol, methodSyntax)
                    if !methodSyntax.Annotations.IsDefaultOrEmpty {
                        let methodAttributes = BindAttributes(
                            methodSyntax.Annotations,
                            AttributeTargetKind.Method,
                            Binder.FunctionDeclarationAllowedTargets,
                            "a method declaration",
                            AttributeTargets.Method
                        )
                        methodSymbol.SetAttributes(methodAttributes)
                        ValidateInlineDataNilArguments(methodAttributes, methodSymbol.Parameters)
                        ValidateUnscopedRefPlacement(methodSymbol)
                    }
                    // Issue #4370: the CLR represents every P/Invoke as a
                    // static method, so `@DllImport` / `@LibraryImport` on an
                    // instance method is rejected with GS0326 (pointing at the
                    // `shared { }` block). The attribute is checked AFTER
                    // binding annotations so the body-less form reports that
                    // one precise error instead of GS0388's misleading
                    // "abstract method must be open" below.
                    let isInstancePInvoke = PInvokeBinder.ReportPInvokeOnInstanceMethod(
                        methodSymbol,
                        methodSyntax,
                        Diagnostics
                    )
                    if methodSyntax.HasSemicolonBody {
                        methodSymbol.IsAbstract = true
                        // ADR-0192 / issue #4301: a body-less method that also
                        // carries `partial` is the DECLARING part of a partial
                        // method that PartialMethodMerger could not pair with an
                        // implementing part — it has already been reported with
                        // GS0609 (or GS0610). It reaches here only as error
                        // recovery, so the symbol stays abstract (the body
                        // binder must still skip the absent body) but GS0388 is
                        // suppressed: the user's mistake is the missing
                        // implementation, not a missing `open`.
                        if (!methodSyntax.IsOpen || !structSymbol.IsOpen) &&
                            !methodSyntax.IsPartial &&
                            !isInstancePInvoke {
                            Diagnostics.ReportAbstractMethodRequiresOpenClass(
                                methodSyntax.Identifier.Location,
                                methodName,
                                structSymbol.Name
                            )
                        }
                    }
                    let nullableSequenceSpecializations = ExpandNullableSequenceIteratorSpecializations(methodSymbol)
                    if nullableSequenceSpecializations.Length > 1 {
                        for specialization in nullableSequenceSpecializations {
                            if methodsBuilder.Any(
                                (existing FunctionSymbol) -> BoundScope.FunctionSignaturesEqual(
                                    existing,
                                    specialization
                                )
                            ) {
                                Diagnostics.ReportDuplicateOverloadSignature(
                                    methodSyntax.Identifier.Location,
                                    methodName,
                                    Binder.FormatOverloadSignature(specialization)
                                )
                                break
                            }
                            methodsBuilder.Add(specialization)
                        }
                        continue
                    }
                    // ADR-0149: a method declared with an explicit-interface
                    // qualifier clause (`func (IFoo) M(...)`) explicitly
                    // implements one interface member's own distinct body.
                    // Resolution against the actual interface member is
                    // deferred to VerifyInterfaceImplementations — interfaces
                    // declared later in the same compilation unit have not had
                    // their own members bound yet when this class's members
                    // are bound, so `implementedInterfaces[i].Methods` may
                    // still be empty here.
                    var hasDuplicateSig = false
                    for existingMethod in methodsBuilder {
                        if BoundScope.FunctionSignaturesEqual(existingMethod, methodSymbol) {
                            // ADR-0149: two methods that share a name and
                            // parameter shape may legitimately coexist when
                            // at least one carries an explicit-interface
                            // qualifier clause — each clause-bearing method
                            // occupies its own distinct (interface, name)
                            // slot (verified/deduplicated later by
                            // VerifyExplicitInterfaceClauseResolution's GS0495
                            // check), so this is not an ordinary overload
                            // collision.
                            if methodSymbol.HasExplicitInterfaceClause || existingMethod.HasExplicitInterfaceClause {
                                continue
                            }
                            // Issue #985: permit two same-name/same-parameter
                            // methods that differ only by return type when they
                            // satisfy two DIFFERENT CLR interface slots (a
                            // covariant-return interface bridge, e.g. the
                            // generic `GetEnumerator() IEnumerator[T]` plus the
                            // non-generic `GetEnumerator() IEnumerator` for
                            // `IEnumerable[T]`). The bridge method is bound to
                            // its inherited slot via an explicit MethodImpl row
                            // at emit time.
                            if MemberLookup.TryResolveCovariantInterfaceBridge(
                                implementedClrInterfaces.ToImmutable(),
                                existingMethod,
                                methodSymbol,
                                out var bridgeMethod,
                                out var bridgeSlot,
                                out var bridgeSlotOwner
                            ) {
                                let resolvedBridgeMethod = bridgeMethod ??
                                    throw InvalidOperationException(
                                    "A covariant interface bridge must identify its bridge method."
                                )
                                let resolvedBridgeSlotOwner = bridgeSlotOwner ??
                                    throw InvalidOperationException(
                                    "A covariant interface bridge must identify its constructed slot owner."
                                )
                                resolvedBridgeMethod.ExplicitInterfaceSlot = bridgeSlot
                                resolvedBridgeMethod.ExplicitInterfaceSlotContainingType = resolvedBridgeSlotOwner
                                continue
                            }
                            Diagnostics.ReportDuplicateOverloadSignature(
                                methodSyntax.Identifier.Location,
                                methodName,
                                Binder.FormatOverloadSignature(methodSymbol)
                            )
                            hasDuplicateSig = true
                            break
                        }
                    }
                    if !hasDuplicateSig {
                        methodsBuilder.Add(methodSymbol)
                    }
                } finally {
                    this.binderCtx.CurrentTypeParameters = enclosingTypeParameters
                }
            }
            structSymbol.SetMethods(methodsBuilder.ToImmutable())
            // Issue #1640: register instance method names so later
            // property/event/field checks reject a name collision with a
            // method, per the "fields + methods + other properties" contract
            // the duplicate-check comments have always claimed.
            for m in methodsBuilder {
                methodNames.Add(m.Name)
            }
        }
    }

    private func BindStructProperties(
        syntax StructDeclarationSyntax,
        $package PackageSymbol,
        structSymbol StructSymbol,
        memberBinding StructMemberBindingContext
    ) {
        let existingNames = memberBinding.ExistingNames
        let methodNames = memberBinding.MethodNames
        let explicitInterfaceClauseNames = memberBinding.ExplicitInterfaceClauseNames
        // ADR-0051: bind property declarations. Positional data members are
        // synthesized as public get/init auto-properties so peer-language
        // consumers see the same ABI as C# records.
        if !syntax.Properties.IsDefaultOrEmpty || (structSymbol.IsData && structSymbol.HasPrimaryConstructor) {
            let propertiesBuilder = ImmutableArray.CreateBuilder[PropertySymbol]()
            let positionalPropertyIndices = Dictionary[string, int32](StringComparer.Ordinal)
            if structSymbol.IsData && structSymbol.HasPrimaryConstructor {
                for parameter in structSymbol.PrimaryConstructorParameters {
                    let property = PropertySymbol(
                        parameter.Name,
                        parameter.Type,
                        Accessibility.Public,
                        hasGetter: true,
                        hasSetter: true,
                        isAutoProperty: true,
                        isVirtual: false,
                        isOverride: false,
                        isInitOnly: true
                    )
                    property.BackingField = FieldSymbol(
                        "<${parameter.Name}>k__BackingField",
                        parameter.Type,
                        if structSymbol.IsClass {
                            Accessibility.Private
                        } else {
                            Accessibility.Internal
                        },
                        isReadOnly: false
                    )
                    let primaryConstructorParameters = syntax.PrimaryConstructorParameters ??
                        throw InvalidOperationException(
                        "A data positional property requires primary constructor parameters."
                    )
                    var parameterSyntax ParameterSyntax? = nil
                    for candidate in primaryConstructorParameters {
                        // ADR-0185: a primary-constructor parameter never
                        // comes from the destructured arrow-lambda path.
                        if candidate.Identifier!!.ValueText == parameter.Name {
                            parameterSyntax = candidate
                            break
                        }
                    }
                    parameterSyntax = Invariant.Required(
                        parameterSyntax,
                        "a data positional property has matching primary constructor syntax",
                        expression: "parameterSyntax"
                    )
                    let propertyAttributes = BindDataPositionalPropertyAttributes(parameterSyntax)
                    if !propertyAttributes.IsDefaultOrEmpty {
                        property.SetAttributes(propertyAttributes)
                    }
                    positionalPropertyIndices[parameter.Name] = propertiesBuilder.Count
                    propertiesBuilder.Add(property)
                    existingNames.Add(parameter.Name)
                }
            }
            // ADR-0187 / issue #4350: indexers overload by index-parameter
            // signature, exactly like C#. Track the plain (non-explicit)
            // indexer signatures already declared on this type so a second
            // `this[...]` with a different parameter list is accepted while an
            // exact duplicate still reports GS0102.
            let declaredIndexerSignatures = List[ImmutableArray[ParameterSymbol]]()
            for propSyntax in syntax.Properties {
                // ADR-0118 / issue #944: an indexer member (`prop this[…] T`)
                // is modelled as a property whose CLR name is `Item` carrying
                // an index-parameter list.
                let isIndexer = propSyntax.IsIndexer
                var indexerParameters = ImmutableArray[ParameterSymbol].Empty
                if isIndexer {
                    if propSyntax.Parameters.Count == 0 {
                        Diagnostics.ReportIndexerRequiresParameter(
                            propSyntax.ThisKeyword?.Location ?? propSyntax.Identifier.Location
                        )
                        continue
                    }
                    let indexerParamBuilder = ImmutableArray.CreateBuilder[ParameterSymbol]()
                    let seenIndexParamNames = HashSet[string]()
                    for indexParamSyntax in propSyntax.Parameters {
                        // ADR-0185: an indexer's parameters never come from
                        // the destructured arrow-lambda path.
                        let indexParamName = indexParamSyntax.Identifier!!.ValueText
                        let indexParamType = if indexParamSyntax.Type is {} indexParamTypeSyntax {
                            bindTypeClause(indexParamTypeSyntax) ?? TypeSymbol.Error
                        } else {
                            TypeSymbol.Error
                        }
                        if !seenIndexParamNames.Add(indexParamName) {
                            Diagnostics.ReportParameterAlreadyDeclared(indexParamSyntax.Location, indexParamName)
                        }
                        let indexerParam = ParameterSymbol(
                            indexParamName,
                            indexParamType,
                            declaringSyntax: indexParamSyntax.Identifier
                        )
                        // Issue #1913: indexer parameters can carry `@Attr`
                        // annotations same as any other parameter list.
                        BindAndAttachParameterAttributes(indexParamSyntax, indexerParam)
                        // Issue #4350 (review): an indexer parameter may declare
                        // a default (`this[row int32, column int32 = 0]`), which
                        // was previously dropped silently.
                        conversions.BindAndAttachParameterDefaultValue(indexParamSyntax, indexerParam)
                        indexerParamBuilder.Add(indexerParam)
                    }
                    indexerParameters = indexerParamBuilder.ToImmutable()
                }
                let propName = if isIndexer {
                    "Item"
                } else {
                    propSyntax.Identifier.ValueText
                }
                var positionalPropertyIndex = -1
                let replacesPositionalProperty = !isIndexer &&
                    !propSyntax.HasExplicitInterfaceClause &&
                    positionalPropertyIndices.TryGetValue(propName, out positionalPropertyIndex)
                // Check for duplicate names (fields + methods + other properties).
                // ADR-0149: exempt when either the new property, or ANY
                // already-declared same-name property, carries an
                // explicit-interface qualifier clause — a plain (implicitly-
                // dispatched) property and a purely-explicit-slot property
                // legitimately share the same source name (that's the exact
                // Oahu `Authorization`/`IProfile.Authorization` shape this
                // clause exists for), and so do two explicit clauses
                // targeting DIFFERENT interfaces. Two explicit clauses that
                // resolve to the SAME interface member are still caught, just
                // later — see GS0495 in VerifyExplicitInterfaceClauseResolution,
                // which has the resolved target identity needed to detect
                // that specific case. Indexers are always named "Item" (issue
                // #944 / #2362 follow-up): this also lets a type declare more
                // than one explicit-interface indexer implementation, closing
                // a gap the old mangled-name convention only partially covered.
                var propAlreadyDeclared = existingNames.Contains(propName) && !replacesPositionalProperty
                if isIndexer &&
                    propAlreadyDeclared &&
                    !propSyntax.HasExplicitInterfaceClause &&
                    declaredIndexerSignatures.Count > 0 {
                    // ADR-0187: an indexer only collides with another plain
                    // indexer of the same index-parameter signature.
                    propAlreadyDeclared = declaredIndexerSignatures.Any(
                        (declared ImmutableArray[ParameterSymbol]) -> HaveSameIndexerSignature(
                            declared,
                            indexerParameters
                        )
                    )
                }
                // Review finding (#4350): the explicit-interface exemption lets a
                // plain indexer share `Item` with explicit implementations, but it
                // never excuses a plain indexer that duplicates another plain
                // indexer's signature.
                let duplicatesPlainIndexer = isIndexer &&
                    !propSyntax.HasExplicitInterfaceClause &&
                    declaredIndexerSignatures
                    .Any(
                    (declared ImmutableArray[ParameterSymbol]) -> HaveSameIndexerSignature(declared, indexerParameters)
                )
                let propExemptCollision = !duplicatesPlainIndexer &&
                    (propSyntax.HasExplicitInterfaceClause || explicitInterfaceClauseNames.Contains(propName))
                if methodNames.Contains(propName) || (propAlreadyDeclared && !propExemptCollision) {
                    Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName)
                    continue
                }
                if !replacesPositionalProperty {
                    existingNames.Add(propName)
                }
                if isIndexer && !propSyntax.HasExplicitInterfaceClause {
                    declaredIndexerSignatures.Add(indexerParameters)
                }
                if propSyntax.HasExplicitInterfaceClause {
                    explicitInterfaceClauseNames.Add(propName)
                }
                let propType TypeSymbol? = if propSyntax.Type is {} propTypeSyntax {
                    bindTypeClause(propTypeSyntax)
                } else {
                    TypeSymbol.Error
                }
                if propType == nil {
                    continue
                }
                let propAccessibility = resolveAccessibility(propSyntax.AccessibilityModifier)
                // Determine accessor presence
                var hasGetter = true
                var hasSetter bool
                var isAutoProperty bool
                var isInitOnly = false
                var setterParamName = "value"
                var getterAccessibility = propAccessibility
                var setterAccessibility = propAccessibility
                if propSyntax.OpenBraceToken == nil {
                    // Bare auto-property: prop Name Type
                    hasSetter = true
                    isAutoProperty = true
                } else {
                    // Has body — check accessors
                    let getAccessor PropertyAccessorSyntax? = propSyntax.Accessors.FirstOrDefault(
                        (a PropertyAccessorSyntax) -> a.IsGetter
                    )
                    let setAccessor PropertyAccessorSyntax? = propSyntax.Accessors.FirstOrDefault(
                        (a PropertyAccessorSyntax) -> a.IsSetter
                    )
                    let initAccessor PropertyAccessorSyntax? = propSyntax.Accessors.FirstOrDefault(
                        (a PropertyAccessorSyntax) -> a.IsInit
                    )
                    // Issue #946: a property may declare a `set` or an `init`
                    // accessor, but not both (mirrors C#).
                    if setAccessor != nil && initAccessor != nil {
                        Diagnostics.ReportPropertyHasBothSetAndInit(initAccessor.AccessorKeyword.Location, propName)
                    }
                    let writeAccessor PropertyAccessorSyntax? = setAccessor ?? initAccessor
                    if getAccessor?.AccessibilityModifier != nil {
                        getterAccessibility = resolveAccessibility(getAccessor!!.AccessibilityModifier)
                    }
                    if writeAccessor?.AccessibilityModifier != nil {
                        setterAccessibility = resolveAccessibility(writeAccessor!!.AccessibilityModifier)
                    }
                    hasGetter = getAccessor != nil || propSyntax.Accessors.IsDefaultOrEmpty
                    hasSetter = writeAccessor != nil
                    isInitOnly = setAccessor == nil && initAccessor != nil
                    if writeAccessor != nil && writeAccessor.ParameterIdentifier != nil {
                        setterParamName = writeAccessor.ParameterIdentifier.ValueText
                    }
                    // Auto-property if accessors have no bodies
                    isAutoProperty = (getAccessor == nil || getAccessor.Body == nil) &&
                        (writeAccessor == nil || writeAccessor.Body == nil) &&
                        propSyntax
                        .Accessors
                        .All((a PropertyAccessorSyntax) -> a.Body == nil)
                    // A bodyless accessor list on an open property declares an
                    // abstract slot; it must not acquire an auto-property field.
                    if propSyntax.OpenModifier != nil && propSyntax.OverrideModifier == nil && hasGetter && !hasSetter {
                        isAutoProperty = false
                    }
                }
                let isExplicitAbstract = propSyntax.AbstractModifier != nil
                if isExplicitAbstract {
                    isAutoProperty = false
                }
                if replacesPositionalProperty && !hasGetter {
                    Diagnostics.ReportPositionalPropertyReplacementRequiresGetter(
                        propSyntax.Identifier.Location,
                        propName
                    )
                    continue
                }
                if replacesPositionalProperty &&
                    propType != propertiesBuilder[positionalPropertyIndex].Type &&
                    (
                    isAutoProperty || !TypeSymbol.AreRuntimeEquivalentIgnoringReferenceNullability(
                        propType,
                        propertiesBuilder[positionalPropertyIndex].Type
                    )
                ) {
                    Diagnostics.ReportCannotConvert(
                        propSyntax.Identifier.Location,
                        propertiesBuilder[positionalPropertyIndex].Type,
                        propType
                    )
                    continue
                }
                if isExplicitAbstract {
                    if !structSymbol.IsDeclaredAbstract ||
                        propSyntax.OpenModifier != nil ||
                        propSyntax.HasExplicitInterfaceClause ||
                        propAccessibility == Accessibility.Private ||
                        (getterAccessibility == Accessibility.Private && hasGetter) ||
                        (setterAccessibility == Accessibility.Private && hasSetter) ||
                        propSyntax.OpenBraceToken == nil ||
                        propSyntax
                        .Accessors
                        .IsDefaultOrEmpty ||
                        propSyntax
                        .Accessors
                        .Any((accessor PropertyAccessorSyntax) -> accessor.Body != nil) {
                        Diagnostics.ReportInvalidAbstractProperty(propSyntax.Identifier.Location, propName)
                    }
                }
                // ADR-0118 / issue #944: there is no auto-indexer form — an
                // indexer must declare a get and/or set accessor with a body.
                if isIndexer && isAutoProperty {
                    Diagnostics.ReportIndexerRequiresAccessorBody(
                        propSyntax.ThisKeyword?.Location ?? propSyntax.Identifier.Location
                    )
                    continue
                }
                // Issue #3879 (ADR-0060 amendment): `prop P ref T { get { … } }`
                // / `prop this[…] ref T -> …`. The getter returns a managed
                // pointer so a CLR consumer can alias the storage; the form is
                // restricted to the computed, read-only shapes — see
                // ValidatePropertyReturnRefKind for why.
                let propReturnRefKind = ValidatePropertyReturnRefKind(
                    propSyntax,
                    propName,
                    propType,
                    hasBodiedGetter: propSyntax.Accessors.Any(
                        (a PropertyAccessorSyntax) -> a.IsGetter && a.Body != nil
                    ),
                    writeAccessor: propSyntax.Accessors.FirstOrDefault((a PropertyAccessorSyntax) -> a.IsSetterOrInit)
                )
                // Validate: open only on open class
                let isVirtual = propSyntax.OpenModifier != nil || isExplicitAbstract
                let isOverride = propSyntax.OverrideModifier != nil
                if isVirtual && !structSymbol.IsOpen {
                    Diagnostics.ReportOpenMemberInNonOpenClass(
                        propSyntax.OpenModifier?.Location ?? propSyntax.Identifier.Location,
                        propName
                    )
                }
                // Validate: override needs base property
                var externalOverriddenProperty PropertyInfo? = nil
                var externalPropertyContainingType TypeSymbol? = nil
                var overriddenProperty PropertySymbol? = nil
                var pendingCovariantCheck = false
                if isOverride {
                    if structSymbol.BaseClass != nil &&
                        TryGetOverriddenPropertyCandidate(
                        structSymbol.BaseClass!!,
                        propName,
                        isIndexer,
                        indexerParameters,
                        out var baseProp
                    ) {
                        if !baseProp!!.IsVirtual && !baseProp!!.IsOverride {
                            Diagnostics.ReportOverrideOfSealedMethod(propSyntax.Identifier.Location, propName)
                        } else if baseProp!!.ReturnRefKind != propReturnRefKind {
                            // Issue #3879: a source base property is selected by
                            // NAME here, so without this the ref-kind never
                            // participated — `override prop P ref T` bound
                            // happily to a by-value base slot, and the override
                            // then returned a managed pointer through a slot the
                            // caller reads by value. The two directions are both
                            // wrong and both report the same signature mismatch.
                            Diagnostics.ReportOverrideSignatureMismatch(propSyntax.Identifier.Location, propName)
                        } else if (hasGetter && !baseProp!!.HasGetter) ||
                            (hasSetter && (!baseProp!!.HasSetter || isInitOnly != baseProp!!.IsInitOnly)) ||
                            (hasGetter && getterAccessibility != baseProp!!.GetterAccessibility) ||
                            (hasSetter && setterAccessibility != baseProp!!.SetterAccessibility) {
                            Diagnostics.ReportOverrideSignatureMismatch(propSyntax.Identifier.Location, propName)
                        } else if PropertyOverrideTypeConforms(structSymbol, baseProp!!, propType) {
                            overriddenProperty = baseProp
                        } else if !hasSetter &&
                            baseProp!!.HasGetter &&
                            !baseProp!!.HasSetter &&
                            propReturnRefKind == RefKind
                            .None {
                            // Issue #4481: a get-only override may narrow the
                            // type to one with an implicit reference conversion
                            // to the base type (C# 9 covariant returns). Its
                            // getter has a different CLR signature, so it cannot
                            // reuse the base slot by name: the emitter gives it a
                            // new slot and binds the base getter to it with a
                            // MethodImpl (#4508). Before this check the type was never
                            // compared, so the getter silently left the base slot
                            // unimplemented (a TypeLoadException at run time).
                            // Whether it IS a narrowing is decided once every
                            // type is bound (see RegisterCovariantPropertyOverrideCheck).
                            // As in C#, the overridden property must be
                            // read-only: only the getter gets a MethodImpl, so a
                            // base setter would stay unimplemented (for an
                            // abstract base, a TypeLoadException).
                            // The base must have a getter to bind to, and the
                            // CLR covariant-return form covers by-value returns
                            // only, so a by-ref narrowing has no override form.
                            overriddenProperty = baseProp
                            pendingCovariantCheck = true
                        } else {
                            Diagnostics.ReportOverrideSignatureMismatch(propSyntax.Identifier.Location, propName)
                        }
                    } else {
                        let externalMatch = ExternalClrOverrideResolver.FindProperty(
                            structSymbol,
                            propName,
                            indexerParameters,
                            propType,
                            hasGetter,
                            hasSetter,
                            isInitOnly,
                            getterAccessibility,
                            setterAccessibility,
                            binderCtx.References,
                            propReturnRefKind
                        )
                        if externalMatch.Member != nil {
                            externalOverriddenProperty = externalMatch.Member
                            externalPropertyContainingType = externalMatch.ContainingType
                        } else if externalMatch.IsSealed {
                            Diagnostics.ReportOverrideOfSealedMethod(propSyntax.Identifier.Location, propName)
                        } else if externalMatch.SawName {
                            Diagnostics.ReportOverrideSignatureMismatch(propSyntax.Identifier.Location, propName)
                        } else {
                            Diagnostics.ReportNoBaseMethodToOverride(propSyntax.Identifier.Location, propName)
                        }
                    }
                }
                let propertySymbol = PropertySymbol(
                    propName,
                    propType,
                    propAccessibility,
                    hasGetter,
                    hasSetter,
                    isAutoProperty,
                    isVirtual,
                    isOverride,
                    setterParamName,
                    declaration: propSyntax,
                    isInitOnly: isInitOnly,
                    getterAccessibility: getterAccessibility,
                    setterAccessibility: setterAccessibility
                ){IsIndexer = isIndexer, Parameters = indexerParameters, ReturnRefKind = propReturnRefKind}
                propertySymbol.OverriddenProperty = overriddenProperty
                if pendingCovariantCheck {
                    RegisterCovariantPropertyOverrideCheck(propertySymbol, propSyntax.Identifier.Location)
                }
                Binder.AttachDocumentation(propertySymbol, propSyntax)
                if externalOverriddenProperty != nil {
                    propertySymbol.ExternalOverriddenGetter = externalOverriddenProperty.GetGetMethod(nonPublic: true)
                    propertySymbol.ExternalOverriddenSetter = externalOverriddenProperty.GetSetMethod(nonPublic: true)
                    propertySymbol.ExternalOverrideContainingType = externalPropertyContainingType
                }
                // Create backing field for auto-properties
                if isAutoProperty {
                    // Issue #3873 / #367: an auto-property's `<P>k__BackingField`
                    // is an ordinary instance field, so it is bound by the same
                    // CLR rules as one the user spelled out — the field-declaration
                    // path above (`!syntax.IsRef && IsByRefLike`) simply never saw
                    // it. Without this the whole type is silently unloadable:
                    // `TypeLoadException: A ByRef or ByRef-like type cannot be used
                    // as the type for an instance field in a non-ByRef-like type`
                    // out of `GetExportedTypes()` — which is the call xunit
                    // discovery makes, so a migrated test assembly ran zero tests
                    // and still reported green (#3869).
                    if !syntax.IsRef && TypeSymbol.IsByRefLike(propType) {
                        Diagnostics.ReportByRefLikeEscape(
                            propSyntax.Identifier.Location,
                            propType,
                            "be used as the type of auto-property '$propName' (its compiler-synthesized backing field is an instance field of a non-`ref struct`)"
                        )
                    }
                    // ADR-0039 §4 / ADR-0058: likewise, a managed pointer (`*T`)
                    // cannot be a field type — CLR metadata has no
                    // ELEMENT_TYPE_BYREF slot in a FieldDef signature. Reaching
                    // emit with one crashed the signature encoder (GS9998) rather
                    // than reporting the real, user-facing rule.
                    if propType is ByRefTypeSymbol byRefPropType {
                        Diagnostics.ReportPointerTypeCannotBeFieldType(
                            propSyntax.Identifier.Location,
                            byRefPropType.Name
                        )
                    }
                    let backingField = FieldSymbol(
                        "<$propName>k__BackingField",
                        propType,
                        Accessibility.Private,
                        isReadOnly: !hasSetter
                    )
                    propertySymbol.BackingField = backingField
                }
                // Create FunctionSymbols for computed property accessors (ADR-0051).
                if !isAutoProperty {
                    let getAccessor = propSyntax.Accessors.FirstOrDefault((a PropertyAccessorSyntax) -> a.IsGetter)
                    // Issue #946: the write accessor is either `set` or `init`.
                    let setAccessor = propSyntax.Accessors.FirstOrDefault(
                        (a PropertyAccessorSyntax) -> a.IsSetterOrInit
                    )
                    if hasGetter && (getAccessor?.Body != nil || isExplicitAbstract) {
                        // Issue #3223: a property override is itself overridable —
                        // the override-validation rule above accepts a base
                        // property that is `IsVirtual || IsOverride` — so the
                        // accessor symbol must be open whenever the property is
                        // `open` OR `override`. Leaving an override accessor
                        // closed made FunctionEmitter stamp it `Final`, and a
                        // grandchild override of that slot produced an
                        // unloadable type (TypeLoadException: "Declaration
                        // referenced in a method implementation cannot be a
                        // final method"). Mirrors the auto-property fallback
                        // path in MemberDefEmitter, which never adds Final to
                        // an override accessor.
                        let getterSymbol = FunctionSymbol(
                            "get_$propName",
                            if isIndexer {
                                indexerParameters
                            } else {
                                ImmutableArray[ParameterSymbol].Empty
                            },
                            propType,
                            declaration: nil,
                            $package,
                            getterAccessibility,
                            receiverType: structSymbol,
                            isOpen: isVirtual || isOverride,
                            isOverride: isOverride
                        ){
                            IsUnsafe = binderCtx.InUnsafeContext,
                            IsAbstract = isExplicitAbstract,
                            OverriddenMethod = overriddenProperty?.GetterSymbol
                        }
                        // Issue #3879: the by-ref return lives on the ACCESSOR
                        // symbol as well as the property. The getter's body is
                        // bound with this symbol as its enclosing function, so
                        // this is what makes `return ref <lvalue>` legal inside
                        // it (and a plain `return` a GS0252), and what makes
                        // FunctionEmitter encode the MethodDef return as `T&`.
                        getterSymbol.ReturnRefKind = propReturnRefKind
                        getterSymbol.ExternalOverriddenMethod = propertySymbol.ExternalOverriddenGetter
                        propertySymbol.GetterSymbol = getterSymbol
                        propertySymbol.GetterBodySyntax = getAccessor?.Body
                    }
                    if hasSetter && (setAccessor?.Body != nil || isExplicitAbstract) {
                        let setterParam = ParameterSymbol(setterParamName, propType)
                        let setterParameters = if isIndexer {
                            indexerParameters.Add(setterParam)
                        } else {
                            ImmutableArray.Create(setterParam)
                        }
                        // Issue #3223: see the matching comment on the getter —
                        // an override property's accessor stays open so a
                        // further override can reuse its (non-Final) slot.
                        let setterSymbol = FunctionSymbol(
                            "set_$propName",
                            setterParameters,
                            TypeSymbol.Void,
                            declaration: nil,
                            $package,
                            setterAccessibility,
                            receiverType: structSymbol,
                            isOpen: isVirtual || isOverride,
                            isOverride: isOverride
                        ){
                            IsUnsafe = binderCtx.InUnsafeContext,
                            IsAbstract = isExplicitAbstract,
                            OverriddenMethod = overriddenProperty?.SetterSymbol
                        }
                        setterSymbol.IsInitOnlySetter = isInitOnly
                        setterSymbol.ExternalOverriddenMethod = propertySymbol.ExternalOverriddenSetter
                        propertySymbol.SetterSymbol = setterSymbol
                        propertySymbol.SetterBodySyntax = setAccessor?.Body
                    }
                }
                // Bind annotations
                if !propSyntax.Annotations.IsDefaultOrEmpty {
                    propertySymbol.SetAttributes(
                        BindAttributes(
                            propSyntax.Annotations,
                            AttributeTargetKind.Property,
                            Binder.PropertyDeclarationAllowedTargets,
                            "a property declaration",
                            AttributeTargets.Property
                        )
                    )
                    // ADR-0184: runs AFTER the accessor symbols are built above,
                    // which is what lets it push @UnscopedRef down onto them.
                    ValidateUnscopedRefPlacement(propertySymbol, structSymbol)
                }
                if replacesPositionalProperty {
                    propertiesBuilder[positionalPropertyIndex] = propertySymbol
                    positionalPropertyIndices.Remove(propName)
                } else {
                    propertiesBuilder.Add(propertySymbol)
                }
            }
            structSymbol.SetProperties(propertiesBuilder.ToImmutable())
        }
    }

    private func BindStructEvents(
        syntax StructDeclarationSyntax,
        $package PackageSymbol,
        structSymbol StructSymbol,
        baseBinding StructBaseBindingResult,
        memberBinding StructMemberBindingContext
    ) {
        let existingNames = memberBinding.ExistingNames
        let methodNames = memberBinding.MethodNames
        let explicitInterfaceClauseNames = memberBinding.ExplicitInterfaceClauseNames
        // ADR-0052: bind event declarations.
        if !syntax.Events.IsDefaultOrEmpty {
            let eventsBuilder = ImmutableArray.CreateBuilder[EventSymbol]()
            for eventSyntax in syntax.Events {
                let eventName = eventSyntax.Identifier.ValueText
                // Check for duplicate names.
                // ADR-0149: mirrors the property collision exemption above —
                // an explicit-clause event legitimately shares its plain
                // name with an ordinary event, a differently-targeted
                // explicit event, or (per CS0102-style field/property/event
                // namespace sharing) any other member kind that has ALSO
                // been marked exempt via an explicit clause of its own. Two
                // explicit clauses resolving to the SAME interface member
                // are still caught later, by GS0495 in
                // VerifyExplicitInterfaceClauseResolution.
                let eventAlreadyDeclared = existingNames.Contains(eventName)
                let eventExemptCollision = eventSyntax.HasExplicitInterfaceClause ||
                    explicitInterfaceClauseNames.Contains(eventName)
                if methodNames.Contains(eventName) || (eventAlreadyDeclared && !eventExemptCollision) {
                    Diagnostics.ReportSymbolAlreadyDeclared(eventSyntax.Identifier.Location, eventName)
                    continue
                }
                existingNames.Add(eventName)
                if eventSyntax.HasExplicitInterfaceClause {
                    explicitInterfaceClauseNames.Add(eventName)
                }
                var handlerType TypeSymbol? = if eventSyntax.Type is {} eventTypeSyntax {
                    bindTypeClause(eventTypeSyntax)
                } else {
                    TypeSymbol.Error
                }
                if handlerType == nil {
                    continue
                }
                handlerType = CanonicalizeInterfaceEventHandlerType(baseBinding, eventName, handlerType)
                handlerType = MemberLookup.CanonicalizeWellKnownEventHandler(handlerType)
                let eventAccessibility = resolveAccessibility(eventSyntax.AccessibilityModifier)
                let isFieldLike = eventSyntax.OpenBraceToken == nil
                let isVirtual = eventSyntax.OpenModifier != nil
                let isOverride = eventSyntax.OverrideModifier != nil
                // Validate: open only on open class
                if isVirtual && !structSymbol.IsOpen {
                    Diagnostics.ReportOpenMemberInNonOpenClass(
                        eventSyntax.OpenModifier?.Location ?? eventSyntax.Identifier.Location,
                        eventName
                    )
                }
                var externalOverriddenEvent EventInfo? = nil
                var externalEventContainingType TypeSymbol? = nil
                var overriddenEvent EventSymbol? = nil
                if isOverride {
                    if structSymbol.BaseClass != nil && TypeMemberModel.TryGetEvent(
                        structSymbol.BaseClass!!,
                        eventName,
                        out var baseEvent
                    ) {
                        if !baseEvent!!.IsVirtual && !baseEvent!!.IsOverride {
                            Diagnostics.ReportOverrideOfSealedMethod(eventSyntax.Identifier.Location, eventName)
                        } else if baseEvent!!.Type != handlerType {
                            Diagnostics.ReportOverrideSignatureMismatch(eventSyntax.Identifier.Location, eventName)
                        } else {
                            overriddenEvent = baseEvent
                        }
                    } else {
                        let externalMatch = ExternalClrOverrideResolver.FindEvent(
                            structSymbol,
                            eventName,
                            handlerType,
                            eventAccessibility,
                            binderCtx.References
                        )
                        if externalMatch.Member != nil {
                            externalOverriddenEvent = externalMatch.Member
                            externalEventContainingType = externalMatch.ContainingType
                        } else if externalMatch.IsSealed {
                            Diagnostics.ReportOverrideOfSealedMethod(eventSyntax.Identifier.Location, eventName)
                        } else if externalMatch.SawName {
                            Diagnostics.ReportOverrideSignatureMismatch(eventSyntax.Identifier.Location, eventName)
                        } else {
                            Diagnostics.ReportNoBaseMethodToOverride(eventSyntax.Identifier.Location, eventName)
                        }
                    }
                }
                let eventSymbol = EventSymbol(
                    eventName,
                    handlerType,
                    eventAccessibility,
                    isFieldLike,
                    isVirtual,
                    isOverride,
                    declaration: eventSyntax
                )
                eventSymbol.OverriddenEvent = overriddenEvent
                Binder.AttachDocumentation(eventSymbol, eventSyntax)
                if externalOverriddenEvent != nil {
                    eventSymbol.ExternalOverriddenAddMethod = externalOverriddenEvent.GetAddMethod(nonPublic: true)
                    eventSymbol.ExternalOverriddenRemoveMethod = externalOverriddenEvent.GetRemoveMethod(
                        nonPublic: true
                    )
                    eventSymbol.ExternalOverriddenRaiseMethod = externalOverriddenEvent.GetRaiseMethod(nonPublic: true)
                    eventSymbol.ExternalOverrideContainingType = externalEventContainingType
                }
                // Create backing field for field-like events
                if isFieldLike {
                    let backingField = FieldSymbol(
                        eventName,
                        handlerType,
                        Accessibility.Private,
                        isReadOnly: false,
                        isEventBackingField: true
                    )
                    eventSymbol.BackingField = backingField
                } else {
                    // Explicit accessors — store body syntax
                    let addAccessor = eventSyntax.Accessors.FirstOrDefault((a EventAccessorSyntax) -> a.IsAdd)
                    let removeAccessor = eventSyntax.Accessors.FirstOrDefault((a EventAccessorSyntax) -> a.IsRemove)
                    let raiseAccessor = eventSyntax.Accessors.FirstOrDefault((a EventAccessorSyntax) -> a.IsRaise)
                    if addAccessor?.Body != nil {
                        eventSymbol.AddBodySyntax = addAccessor.Body
                    }
                    if removeAccessor?.Body != nil {
                        eventSymbol.RemoveBodySyntax = removeAccessor.Body
                    }
                    if raiseAccessor?.Body != nil {
                        eventSymbol.RaiseBodySyntax = raiseAccessor.Body
                    }
                }
                // Create add/remove method symbols.
                // Issue #3223: like a property override, an event override is
                // itself overridable (the override-validation rule above
                // accepts a base event that is `IsVirtual || IsOverride`), so
                // accessor symbols must be open whenever the event is `open`
                // OR `override` — otherwise FunctionEmitter stamps the
                // computed accessor `Final` and a grandchild override produces
                // an unloadable type.
                let handlerParam = ParameterSymbol("value", handlerType)
                eventSymbol.AddMethodSymbol = FunctionSymbol(
                    "add_$eventName",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: nil,
                    $package,
                    eventAccessibility,
                    receiverType: structSymbol,
                    isOpen: isVirtual || isOverride,
                    isOverride: isOverride
                ){
                    IsUnsafe = binderCtx.InUnsafeContext,
                    IsSpecialName = true,
                    ExternalOverriddenMethod = eventSymbol.ExternalOverriddenAddMethod
                }
                eventSymbol.RemoveMethodSymbol = FunctionSymbol(
                    "remove_$eventName",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: nil,
                    $package,
                    eventAccessibility,
                    receiverType: structSymbol,
                    isOpen: isVirtual || isOverride,
                    isOverride: isOverride
                ){
                    IsUnsafe = binderCtx.InUnsafeContext,
                    IsSpecialName = true,
                    ExternalOverriddenMethod = eventSymbol.ExternalOverriddenRemoveMethod
                }
                // Issue #257: create raise method symbol if raise accessor is present.
                if eventSyntax.Accessors.Any((a EventAccessorSyntax) -> a.IsRaise) {
                    var raiseParams = ImmutableArray[ParameterSymbol].Empty
                    if MemberLookup.TryGetDelegateFunctionTypeFromSymbol(handlerType, out var fnType) {
                        let builder = ImmutableArray.CreateBuilder[ParameterSymbol](fnType.ParameterTypes.Length)
                        for var pi = 0; pi < fnType.ParameterTypes.Length; pi++ {
                            builder.Add(ParameterSymbol("arg$pi", fnType.ParameterTypes[pi]))
                        }
                        raiseParams = builder.ToImmutable()
                    }
                    eventSymbol.RaiseMethodSymbol = FunctionSymbol(
                        "raise_$eventName",
                        raiseParams,
                        TypeSymbol.Void,
                        declaration: nil,
                        $package,
                        eventAccessibility,
                        receiverType: structSymbol,
                        isOpen: isVirtual || isOverride,
                        isOverride: isOverride
                    ){
                        IsUnsafe = binderCtx.InUnsafeContext,
                        IsSpecialName = true,
                        ExternalOverriddenMethod = eventSymbol.ExternalOverriddenRaiseMethod
                    }
                }
                // Bind annotations
                if !eventSyntax.Annotations.IsDefaultOrEmpty {
                    eventSymbol.SetAttributes(
                        BindAttributes(
                            eventSyntax.Annotations,
                            AttributeTargetKind.Event,
                            Binder.EventDeclarationAllowedTargets,
                            "an event declaration",
                            AttributeTargets.Event
                        )
                    )
                }
                eventsBuilder.Add(eventSymbol)
            }
            structSymbol.SetEvents(eventsBuilder.ToImmutable())
        }
    }

    private func BindStructSharedBlock(
        syntax StructDeclarationSyntax,
        $package PackageSymbol,
        structSymbol StructSymbol,
        fieldBinding StructFieldBindingResult,
        memberBinding StructMemberBindingContext
    ) {
        if syntax.SharedBlock is {} sharedBlock && !sharedBlock.InitBlocks.IsDefaultOrEmpty {
            structSymbol.StaticInitializerFunction = FunctionSymbol(
                "<static-initializer>",
                ImmutableArray[ParameterSymbol].Empty,
                TypeSymbol.Void
            ){
                IsUnsafe = binderCtx.InUnsafeContext,
                IsStatic = true,
                StaticOwnerType = structSymbol,
                IsStaticInitializer = true
            }
        }
        BindStructSharedFields(syntax, structSymbol, fieldBinding, memberBinding)
        BindStructSharedMethods(syntax, $package, structSymbol, memberBinding)
        BindStructSharedProperties(syntax, $package, structSymbol, memberBinding)
        BindStructSharedEvents(syntax, $package, structSymbol, memberBinding)
    }

    /// Issue #5520: whether a `shared` field initializer runs no code: a literal, possibly parenthesized or under a
    /// unary operator (`-1`). Anything else (a call, a name, a construction) is user code or may be (ADR-0208 R11
    /// and R15 read it through `DeclaresNonLiteralSharedFieldInitializer`).
    private func IsLiteralInitializerSyntax(initializer ExpressionSyntax) bool {
        var current = initializer
        for var depth = 0; depth < 64; depth++ {
            if current is LiteralExpressionSyntax {
                return true
            }
            if current is ParenthesizedExpressionSyntax parenthesized {
                current = parenthesized.Expression
            } else if current is UnaryExpressionSyntax unary {
                current = unary.Operand
            } else {
                return false
            }
        }
        return false
    }

    private func BindStructSharedFields(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        fieldBinding StructFieldBindingResult,
        memberBinding StructMemberBindingContext
    ) {
        let existingNames = memberBinding.ExistingNames
        let methodNames = memberBinding.MethodNames
        let pendingStaticFieldInitializers = fieldBinding.PendingStaticFieldInitializers
        let pendingSharedConstInitializers = fieldBinding.PendingSharedConstInitializers
        // ADR-0053: bind members declared inside the optional `shared { … }` block
        // as static members on the struct/class symbol.
        if syntax.SharedBlock != nil {
            // Static fields
            let staticFieldsBuilder = ImmutableArray.CreateBuilder[FieldSymbol]()
            let sharedConstFieldsBuilder = ImmutableArray.CreateBuilder[FieldSymbol]()
            for fieldSyntax in syntax.SharedBlock!!.Fields {
                let fieldName = fieldSyntax.Identifier.ValueText
                if methodNames.Contains(fieldName) || !existingNames.Add(fieldName) {
                    Diagnostics.ReportSymbolAlreadyDeclared(fieldSyntax.Identifier.Location, fieldName)
                    continue
                }
                let fieldType TypeSymbol? = bindTypeClause(fieldSyntax.Type)
                if fieldType == nil {
                    continue
                }
                // Issue #367: a by-ref-like (`ref struct`) value cannot be stored
                // in a static field (statics are rooted on the heap).
                if TypeSymbol.IsByRefLike(fieldType) {
                    Diagnostics.ReportByRefLikeEscape(
                        fieldSyntax.Identifier.Location,
                        fieldType,
                        "be used as the type of field '$fieldName'"
                    )
                    continue
                }
                // ADR-0039 §4 / ADR-0058: a managed pointer (*T) cannot be a field type.
                if fieldType is ByRefTypeSymbol byRefStaticFieldType {
                    Diagnostics.ReportPointerTypeCannotBeFieldType(
                        fieldSyntax.Identifier.Location,
                        byRefStaticFieldType.Name
                    )
                    continue
                }
                let fieldAccessibility = resolveAccessibility(fieldSyntax.AccessibilityModifier)
                // Issue #948: a `const` declared inside a `shared` block is also
                // a compile-time constant literal field (const is implicitly
                // static, so `shared` is redundant but accepted).
                if fieldSyntax.IsConst {
                    if fieldType == TypeSymbol.NInt || fieldType == TypeSymbol.NUInt {
                        Diagnostics.ReportConstNativeIntegerNotSupported(
                            fieldSyntax.Identifier.Location,
                            fieldName,
                            fieldType.Name
                        )
                        continue
                    }
                    let sharedConstField = FieldSymbol(
                        fieldName,
                        fieldType,
                        fieldAccessibility,
                        isReadOnly: true,
                        isStatic: true,
                        isConst: true,
                        declaration: fieldSyntax
                    )
                    Binder.AttachDocumentation(sharedConstField, fieldSyntax)
                    if !fieldSyntax.Annotations.IsDefaultOrEmpty {
                        sharedConstField.SetAttributes(
                            BindAttributes(
                                fieldSyntax.Annotations,
                                AttributeTargetKind.Field,
                                Binder.FieldDeclarationAllowedTargets,
                                "a field declaration",
                                AttributeTargets.Field
                            )
                        )
                    }
                    if fieldSyntax.Initializer == nil {
                        Diagnostics.ReportConstFieldRequiresInitializer(fieldSyntax.Identifier.Location, fieldName)
                    } else {
                        // Issue #1070: defer folding to the consolidated pass so a
                        // shared const can reference a sibling static/const member
                        // regardless of declaration order.
                        pendingSharedConstInitializers.Add((sharedConstField, fieldSyntax, fieldType))
                    }
                    sharedConstFieldsBuilder.Add(sharedConstField)
                    continue
                }
                let fieldSymbol = FieldSymbol(
                    fieldName,
                    fieldType,
                    fieldAccessibility,
                    isReadOnly: fieldSyntax.IsReadOnly,
                    isStatic: true,
                    declaration: fieldSyntax
                )
                if !fieldSyntax.Annotations.IsDefaultOrEmpty {
                    fieldSymbol.SetAttributes(
                        BindAttributes(
                            fieldSyntax.Annotations,
                            AttributeTargetKind.Field,
                            Binder.FieldDeclarationAllowedTargets,
                            "a field declaration",
                            AttributeTargets.Field
                        )
                    )
                }
                Binder.AttachDocumentation(fieldSymbol, fieldSyntax)
                // Issue #262 / issue #1070: defer initializer binding to the
                // consolidated pass so it can see all sibling static/const members.
                if fieldSyntax.Initializer is {} staticInitializer {
                    pendingStaticFieldInitializers.Add((fieldSymbol, staticInitializer, fieldType))
                    if !IsLiteralInitializerSyntax(staticInitializer) {
                        structSymbol.DeclaresNonLiteralSharedFieldInitializer = true
                    }
                } else if MagicCollectionZeroValue.MightNeedZeroValue(fieldType) {
                    // Issue #3310 / ADR-0159 (extended by #3319 for
                    // struct-typed fields): a candidate zero-value static
                    // field, synthesized (or resolved to no-op) into the
                    // `.cctor` in the deferred pass — see the matching probe
                    // above for instance fields for why this cannot recurse
                    // here.
                    fieldBinding.PendingZeroValueStaticFields.Add((fieldSymbol, fieldSyntax))
                } else if MagicCollectionZeroValue.RequiresExplicitInitializer(fieldType) {
                    // Issue #3310 / ADR-0159 channel carve-out: a bare
                    // `chan T` static field has no usable default.
                    if !ManagedReferenceTypes.TryGetElement(fieldType, out _, out _) &&
                        !NativeProtocolMetadata
                        .IsProtocol(fieldType) {
                        Diagnostics.ReportChannelRequiresInitializer(
                            fieldSyntax.Identifier.Location,
                            fieldName,
                            fieldType.Name
                        )
                    }
                }
                staticFieldsBuilder.Add(fieldSymbol)
            }
            structSymbol.SetStaticFields(staticFieldsBuilder.ToImmutable())
            // Issue #948: merge any const fields declared inside the shared block
            // with the body-level const fields already installed on the symbol.
            if sharedConstFieldsBuilder.Count > 0 {
                structSymbol.SetConstFields(structSymbol.ConstFields.AddRange(sharedConstFieldsBuilder.ToImmutable()))
            }
        }
    }

    private func BindStructSharedMethods(
        syntax StructDeclarationSyntax,
        $package PackageSymbol,
        structSymbol StructSymbol,
        memberBinding StructMemberBindingContext
    ) {
        let existingNames = memberBinding.ExistingNames
        let methodNames = memberBinding.MethodNames
        if syntax.SharedBlock != nil {
            // Static methods
            let staticMethodsBuilder = ImmutableArray.CreateBuilder[FunctionSymbol]()
            for methodSyntax in syntax.SharedBlock!!.Methods {
                let methodName = methodSyntax.Identifier.ValueText
                // ADR-0063: allow same-name overloads in a shared block; only reject
                // collision with a non-method member of the same name (field/property/event).
                if existingNames.Contains(methodName) {
                    Diagnostics.ReportSymbolAlreadyDeclared(methodSyntax.Identifier.Location, methodName)
                    continue
                }
                // Issue #410 / ADR-0029: forbid user-written synthesized members
                // on data structs even when declared as shared/static methods.
                if structSymbol.IsData && IsDataStructSynthesizedMemberName(methodName) {
                    Diagnostics.ReportDataStructSynthesizedMemberConflict(
                        methodSyntax.Identifier.Location,
                        structSymbol.Name,
                        structSymbol.IsClass,
                        methodName
                    )
                    continue
                }
                if structSymbol.IsInline && IsInlineSynthesizedMemberName(methodName) {
                    Diagnostics.ReportInlineStructSynthesizedMemberConflict(
                        methodSyntax.Identifier.Location,
                        structSymbol.Name,
                        methodName
                    )
                    continue
                }
                // Issue #312 / ADR-0020: support generic static methods too.
                let methodTypeParameters = BindTypeParameterList(methodSyntax.TypeParameterList)
                let enclosingTypeParameters Dictionary[string, TypeParameterSymbol]? = binderCtx.CurrentTypeParameters
                if !methodTypeParameters.IsDefaultOrEmpty {
                    this.binderCtx.CurrentTypeParameters = if enclosingTypeParameters == nil {
                        Dictionary[string, TypeParameterSymbol]()
                    } else {
                        Dictionary[string, TypeParameterSymbol](enclosingTypeParameters)
                    }
                    for tp in methodTypeParameters {
                        binderCtx.CurrentTypeParameters!![tp.Name] = tp
                    }
                }
                try {
                    // ADR-0122 / issue #1036: bind an `unsafe func` static/shared
                    // method's signature (params + return) in an unsafe context
                    // too, so it may use unmanaged raw pointers even when the
                    // enclosing type is safe. No-op for a non-`unsafe` method.
                    using let sigUnsafeContext = binderCtx.PushUnsafeContext(methodSyntax.IsUnsafe)
                    let parameters = ImmutableArray.CreateBuilder[ParameterSymbol]()
                    let seenParameterNames = HashSet[string]()
                    for parameterSyntax in methodSyntax.Parameters {
                        // ADR-0185: a static/shared struct method's
                        // parameters never come from the destructured
                        // arrow-lambda path.
                        let parameterName = parameterSyntax.Identifier!!.ValueText
                        var parameterType = if parameterSyntax.Type is {} parameterTypeSyntax {
                            bindTypeClause(parameterTypeSyntax) ?? TypeSymbol.Error
                        } else {
                            TypeSymbol.Error
                        }
                        // ADR-0101 follow-up / issue #812: variadic parameters
                        // are now accepted on shared/static class methods. The
                        // body sees the parameter as `[]T`; the static-call
                        // path goes through the same overload resolver that
                        // handles top-level variadic functions.
                        let isVariadic = parameterSyntax.IsVariadic
                        if isVariadic && parameterType != TypeSymbol.Error {
                            parameterType = VariadicCarriers.ResolveDeclaredParameterType(parameterType)
                        }
                        let parameterRefKind = conversions.BindAndValidateParameterRefKind(
                            parameterSyntax,
                            parameterName,
                            parameterType,
                            isVariadic,
                            asyncOrIteratorKind: if methodSyntax.IsAsync {
                                "async"
                            } else {
                                (
                                    if methodSyntax.IsSuspend {
                                        "suspend"
                                    } else {
                                        default(string?)
                                    }
                                )
                            }
                        )
                        // Issue #1262: `_` is the discard identifier — repeated `_` parameters are
                        // permitted on named functions/methods. Each `_` occupies a positional slot
                        // but is not added to the body scope, so non-`_` duplicates still error.
                        if parameterName != "_" && !seenParameterNames.Add(parameterName) {
                            Diagnostics.ReportParameterAlreadyDeclared(parameterSyntax.Location, parameterName)
                        } else {
                            let staticMethodParam = ParameterSymbol(
                                parameterName,
                                parameterType,
                                isVariadic,
                                declaringSyntax: parameterSyntax.Identifier,
                                isScoped: parameterSyntax.IsScoped,
                                refKind: parameterRefKind
                            )
                            DeferParameterDefaultValueBinding(
                                parameterSyntax,
                                staticMethodParam,
                                structSymbol,
                                $package,
                                methodTypeParameters
                            )
                            BindAndAttachParameterAttributes(parameterSyntax, staticMethodParam)
                            parameters.Add(staticMethodParam)
                        }
                    }
                    ValidateVariadicParameterShape(methodSyntax.Parameters)
                    var returnType = BindIteratorReturnType(methodSyntax)
                    let methodAccessibility = resolveAccessibility(methodSyntax.AccessibilityModifier)
                    // ADR-0146 (Kotlin visibility narrowing follow-up): infer/narrow the
                    // return type when the (omitted-type) body is `-> object { ... }`.
                    returnType = InferAnonymousClassLiteralReturnType(methodSyntax, returnType, methodAccessibility)
                    let methodIsAsyncVoid = IsExplicitAsyncVoid(methodSyntax, returnType)
                    returnType = NormalizeAsyncDeclaredReturnType(
                        returnType,
                        methodSyntax.IsAsync,
                        out var returnTypeIsValueTask
                    )
                    let methodReturnRefKind = ValidateReturnRefKind(methodSyntax, returnType)
                    let sharedMethodParameters = parameters.ToImmutable()
                    // ADR-0199: the print-members slot is an instance method; a
                    // shared one of that shape is rejected like any other bad shape.
                    if structSymbol.IsData && DataPrintMembersModel.IsSlotCandidate(
                        methodName,
                        methodSyntax.HasExplicitInterfaceClause,
                        sharedMethodParameters
                    ) {
                        Diagnostics.ReportIncompatibleDataPrintMembers(
                            methodSyntax.Identifier.Location,
                            structSymbol.Name,
                            structSymbol.IsClass,
                            if DataPrintMembersModel.GetRequiredAccessibility(structSymbol) == Accessibility.Private {
                                "private"
                            } else {
                                "protected"
                            }
                        )
                        continue
                    }
                    // Copilot review round 7: the declaring part's own
                    // return/parameter type clauses were discarded after
                    // only a textual comparison; bind and compare them
                    // semantically too.
                    ValidateMergedPartialMethodSignatureBinding(
                        methodSyntax,
                        returnType,
                        sharedMethodParameters,
                        methodTypeParameters,
                        structSymbol,
                        $package
                    )
                    let methodSymbol = FunctionSymbol(
                        methodName,
                        sharedMethodParameters,
                        returnType,
                        methodSyntax,
                        $package,
                        methodAccessibility,
                        receiverType: default(TypeSymbol?)
                    )
                    methodSymbol.IsStatic = true
                    methodSymbol.StaticOwnerType = structSymbol
                    methodSymbol.TypeParameters = methodTypeParameters
                    methodSymbol.ReturnRefKind = methodReturnRefKind
                    methodSymbol.IsAsync = methodSyntax.IsAsync ||
                        (
                        isAsyncIteratorReturnType(returnType) &&
                            methodSyntax.Body is {} methodBody &&
                            IteratorDetection.ContainsYield(methodBody)
                    )
                    methodSymbol.IsAsyncVoid = methodIsAsyncVoid
                    methodSymbol.SuspendingKind = if methodSyntax.IsSuspend {
                        SuspendingKind.Declared
                    } else {
                        SuspendingKind.None
                    }
                    methodSymbol.AsyncReturnsValueTask = returnTypeIsValueTask || methodSyntax.IsSuspend
                    methodSymbol.IsUnsafe = binderCtx.InUnsafeContext
                    if !methodSyntax.Annotations.IsDefaultOrEmpty {
                        let methodAttributes = BindAttributes(
                            methodSyntax.Annotations,
                            AttributeTargetKind.Method,
                            Binder.FunctionDeclarationAllowedTargets,
                            "a method declaration",
                            AttributeTargets.Method
                        )
                        methodSymbol.SetAttributes(methodAttributes)
                        ValidateInlineDataNilArguments(methodAttributes, methodSymbol.Parameters)
                        ValidateUnscopedRefPlacement(methodSymbol)
                    }
                    Binder.AttachDocumentation(methodSymbol, methodSyntax)
                    // ADR-0086 / issue #1203: a `shared`-block method may be a
                    // static P/Invoke (`@DllImport ... func F(...) R;`). Resolve
                    // and attach the PInvokeMetadata so the body-binder skips the
                    // (absent) body and the emitter writes the ImplMap row. A
                    // bodyless `shared` method that is NOT a P/Invoke is reported
                    // with GS0325, mirroring the top-level free-function path.
                    // ADR-0192 / issue #4301: `&& !methodSyntax.IsPartial` — a
                    // body-less `partial func` inside `shared { }` is the
                    // DECLARING part of a partial method, whose body legitimately
                    // lives in another part. If no implementing part was found,
                    // PartialMethodMerger has already reported GS0609/GS0610;
                    // GS0325 ("only @DllImport functions may use a ';' body
                    // marker") would be a misleading second error.
                    let isStaticPInvoke = PInvokeBinder.TryAttachPInvokeMetadata(
                        methodSymbol,
                        methodSyntax,
                        Diagnostics
                    )
                    if isStaticPInvoke {
                        PInvokeBinder.ReportPInvokeInGenericType(methodSymbol, structSymbol, methodSyntax, Diagnostics)
                    }
                    if !isStaticPInvoke && methodSyntax.HasSemicolonBody && !methodSyntax.IsPartial {
                        Diagnostics.ReportSemicolonBodyRequiresDllImport(
                            methodSyntax.Identifier.Location,
                            methodSymbol.Name
                        )
                    }
                    if !isStaticPInvoke {
                        PInvokeBinder.ReportMarshalAsOnNonPInvokeFunction(methodSyntax, Diagnostics)
                    }
                    let nullableSequenceSpecializations = ExpandNullableSequenceIteratorSpecializations(methodSymbol)
                    if nullableSequenceSpecializations.Length > 1 {
                        for specialization in nullableSequenceSpecializations {
                            if staticMethodsBuilder.Any(
                                (existing FunctionSymbol) -> BoundScope.FunctionSignaturesEqual(
                                    existing,
                                    specialization
                                )
                            ) {
                                Diagnostics.ReportDuplicateOverloadSignature(
                                    methodSyntax.Identifier.Location,
                                    methodName,
                                    Binder.FormatOverloadSignature(specialization)
                                )
                                break
                            }
                            staticMethodsBuilder.Add(specialization)
                        }
                        continue
                    }
                    // ADR-0063 §11: detect duplicate-signature within the static block.
                    var hasDupSig = false
                    for existingMethod in staticMethodsBuilder {
                        if BoundScope.FunctionSignaturesEqual(existingMethod, methodSymbol) {
                            // ADR-0149 follow-up (issue #2370): mirrors the
                            // instance-method exemption above — two static
                            // methods that share a name and parameter shape
                            // may legitimately coexist when at least one
                            // carries an explicit-interface qualifier clause
                            // (`func (IFoo) M(...)` inside a `shared { }`
                            // block); each occupies its own distinct
                            // (interface, name) static-virtual slot, verified/
                            // deduplicated later by
                            // VerifyExplicitInterfaceClauseResolution's GS0495
                            // check, so this is not an ordinary overload
                            // collision.
                            if methodSymbol.HasExplicitInterfaceClause || existingMethod.HasExplicitInterfaceClause {
                                continue
                            }
                            Diagnostics.ReportDuplicateOverloadSignature(
                                methodSyntax.Identifier.Location,
                                methodName,
                                Binder.FormatOverloadSignature(methodSymbol)
                            )
                            hasDupSig = true
                            break
                        }
                    }
                    if !hasDupSig {
                        staticMethodsBuilder.Add(methodSymbol)
                    }
                } finally {
                    this.binderCtx.CurrentTypeParameters = enclosingTypeParameters
                }
            }
            structSymbol.SetStaticMethods(staticMethodsBuilder.ToImmutable())
            // Issue #1640: register shared/static method names too, so a
            // shared property/event/field colliding with a shared method name
            // is still caught (methods vs methods remain overload-compatible;
            // see the ADR-0063 signature check above).
            for m in staticMethodsBuilder {
                methodNames.Add(m.Name)
            }
        }
    }

    private func BindStructSharedProperties(
        syntax StructDeclarationSyntax,
        $package PackageSymbol,
        structSymbol StructSymbol,
        memberBinding StructMemberBindingContext
    ) {
        let existingNames = memberBinding.ExistingNames
        let methodNames = memberBinding.MethodNames
        let explicitInterfaceClauseNames = memberBinding.ExplicitInterfaceClauseNames
        if syntax.SharedBlock != nil {
            // Static properties
            let staticPropertiesBuilder = ImmutableArray.CreateBuilder[PropertySymbol]()
            for propSyntax in syntax.SharedBlock!!.Properties {
                if propSyntax.AbstractModifier != nil {
                    Diagnostics.ReportInvalidAbstractProperty(
                        propSyntax.Identifier.Location,
                        propSyntax.Identifier.ValueText
                    )
                    continue
                }
                // ADR-0118 / issue #944: a `shared` (static) indexer has no CLR
                // representation — report a clean diagnostic rather than crashing.
                if propSyntax.IsIndexer {
                    Diagnostics.ReportIndexerRequiresAccessorBody(
                        propSyntax.ThisKeyword?.Location ?? propSyntax.Identifier.Location
                    )
                    continue
                }
                let propName = propSyntax.Identifier.ValueText
                // ADR-0149 follow-up (issue #2370): mirrors the instance-
                // property exemption above (`propExemptCollision`) — a static
                // property carrying an explicit-interface qualifier clause
                // may share its source name with another already-declared
                // static/shared member when at least one side is clause-
                // qualified (two same-named static-virtual interface slots
                // disambiguated by different target interfaces, or a plain
                // static member coexisting with a same-named explicit-clause
                // one). A duplicate SLOT claim (same clause target) is still
                // caught later by GS0495 in
                // VerifyExplicitInterfaceClauseResolution.
                let staticPropAlreadyDeclared = existingNames.Contains(propName)
                let staticPropExemptCollision = propSyntax.HasExplicitInterfaceClause ||
                    explicitInterfaceClauseNames.Contains(propName)
                if methodNames.Contains(propName) || (staticPropAlreadyDeclared && !staticPropExemptCollision) {
                    Diagnostics.ReportSymbolAlreadyDeclared(propSyntax.Identifier.Location, propName)
                    continue
                }
                existingNames.Add(propName)
                if propSyntax.HasExplicitInterfaceClause {
                    explicitInterfaceClauseNames.Add(propName)
                }
                let propType TypeSymbol? = if propSyntax.Type is {} propTypeSyntax {
                    bindTypeClause(propTypeSyntax)
                } else {
                    TypeSymbol.Error
                }
                if propType == nil {
                    continue
                }
                let propAccessibility = resolveAccessibility(propSyntax.AccessibilityModifier)
                var hasGetter = true
                var hasSetter bool
                var isAutoProperty bool
                var setterParamName = "value"
                var getterAccessibility = propAccessibility
                var setterAccessibility = propAccessibility
                if propSyntax.OpenBraceToken == nil {
                    hasSetter = true
                    isAutoProperty = true
                } else {
                    let getAccessor PropertyAccessorSyntax? = propSyntax.Accessors.FirstOrDefault(
                        (a PropertyAccessorSyntax) -> a.IsGetter
                    )
                    let setAccessor PropertyAccessorSyntax? = propSyntax.Accessors.FirstOrDefault(
                        (a PropertyAccessorSyntax) -> a.IsSetter
                    )
                    let initAccessor PropertyAccessorSyntax? = propSyntax.Accessors.FirstOrDefault(
                        (a PropertyAccessorSyntax) -> a.IsInit
                    )
                    let writeAccessor = setAccessor ?? initAccessor
                    if getAccessor?.AccessibilityModifier != nil {
                        getterAccessibility = resolveAccessibility(getAccessor!!.AccessibilityModifier)
                    }
                    if writeAccessor?.AccessibilityModifier != nil {
                        setterAccessibility = resolveAccessibility(writeAccessor!!.AccessibilityModifier)
                    }
                    // Issue #946: `init` is instance-only; reject it on a static
                    // property declared inside a `shared` block (ADR-0053).
                    if initAccessor != nil {
                        Diagnostics.ReportInitAccessorOnStaticProperty(initAccessor.AccessorKeyword.Location, propName)
                    }
                    hasGetter = getAccessor != nil || propSyntax.Accessors.IsDefaultOrEmpty
                    hasSetter = setAccessor != nil || initAccessor != nil
                    if setAccessor != nil && setAccessor.ParameterIdentifier != nil {
                        setterParamName = setAccessor.ParameterIdentifier.ValueText
                    }
                    isAutoProperty = (getAccessor == nil || getAccessor.Body == nil) &&
                        (setAccessor == nil || setAccessor.Body == nil) &&
                        propSyntax
                        .Accessors
                        .All((a PropertyAccessorSyntax) -> a.Body == nil)
                }
                // Issue #3879 (ADR-0060 amendment): a `shared` (static) property
                // may return by reference on exactly the same terms as an
                // instance one — C#'s `public static ref int P => ref slot`.
                let staticPropReturnRefKind = ValidatePropertyReturnRefKind(
                    propSyntax,
                    propName,
                    propType,
                    hasBodiedGetter: propSyntax.Accessors.Any(
                        (a PropertyAccessorSyntax) -> a.IsGetter && a.Body != nil
                    ),
                    writeAccessor: propSyntax.Accessors.FirstOrDefault((a PropertyAccessorSyntax) -> a.IsSetterOrInit)
                )
                let propertySymbol = PropertySymbol(
                    propName,
                    propType,
                    propAccessibility,
                    hasGetter,
                    hasSetter,
                    isAutoProperty,
                    isVirtual: false,
                    isOverride: false,
                    setterParamName,
                    isStatic: true,
                    declaration: propSyntax,
                    getterAccessibility: getterAccessibility,
                    setterAccessibility: setterAccessibility
                ){ReturnRefKind = staticPropReturnRefKind}
                if isAutoProperty {
                    // Issue #3873 / #367: a `shared` auto-property's backing field
                    // is a STATIC field, which is rooted on the heap — so unlike
                    // the instance case there is no `ref struct` container that
                    // makes it legal, exactly as for a spelled-out static field
                    // (BindStructSharedFields). The runtime is explicit about the
                    // difference: `TypeLoadException: A ByRef or ByRef-like type
                    // cannot be used as the type for a static field`.
                    if TypeSymbol.IsByRefLike(propType) {
                        Diagnostics.ReportByRefLikeEscape(
                            propSyntax.Identifier.Location,
                            propType,
                            "be used as the type of shared auto-property '$propName' (its compiler-synthesized backing field is a static field)"
                        )
                    }
                    // ADR-0039 §4 / ADR-0058: a managed pointer (`*T`) cannot be a
                    // field type.
                    if propType is ByRefTypeSymbol byRefStaticPropType {
                        Diagnostics.ReportPointerTypeCannotBeFieldType(
                            propSyntax.Identifier.Location,
                            byRefStaticPropType.Name
                        )
                    }
                    let backingField = FieldSymbol(
                        "<$propName>k__BackingField",
                        propType,
                        Accessibility.Private,
                        isReadOnly: !hasSetter,
                        isStatic: true
                    )
                    propertySymbol.BackingField = backingField
                }
                // Issue #263: create FunctionSymbols for computed static property accessors.
                if !isAutoProperty {
                    let getAccessor = propSyntax.Accessors.FirstOrDefault((a PropertyAccessorSyntax) -> a.IsGetter)
                    let setAccessor = propSyntax.Accessors.FirstOrDefault((a PropertyAccessorSyntax) -> a.IsSetter)
                    if hasGetter && getAccessor?.Body != nil {
                        let getterSymbol = FunctionSymbol(
                            "get_$propName",
                            ImmutableArray[ParameterSymbol].Empty,
                            propType,
                            declaration: nil,
                            $package,
                            getterAccessibility,
                            receiverType: default(TypeSymbol?)
                        )
                        getterSymbol.IsStatic = true
                        getterSymbol.IsUnsafe = binderCtx.InUnsafeContext
                        getterSymbol.StaticOwnerType = structSymbol
                        // Issue #3879: see the instance path — the accessor
                        // symbol carries the ref-kind so the body binder and
                        // FunctionEmitter both see it.
                        getterSymbol.ReturnRefKind = staticPropReturnRefKind
                        propertySymbol.GetterSymbol = getterSymbol
                        propertySymbol.GetterBodySyntax = getAccessor.Body
                    }
                    if hasSetter && setAccessor?.Body != nil {
                        let setterParam = ParameterSymbol(setterParamName, propType)
                        let setterSymbol = FunctionSymbol(
                            "set_$propName",
                            ImmutableArray.Create(setterParam),
                            TypeSymbol.Void,
                            declaration: nil,
                            $package,
                            setterAccessibility,
                            receiverType: default(TypeSymbol?)
                        )
                        setterSymbol.IsStatic = true
                        setterSymbol.IsUnsafe = binderCtx.InUnsafeContext
                        setterSymbol.StaticOwnerType = structSymbol
                        propertySymbol.SetterSymbol = setterSymbol
                        propertySymbol.SetterBodySyntax = setAccessor.Body
                    }
                }
                if !propSyntax.Annotations.IsDefaultOrEmpty {
                    propertySymbol.SetAttributes(
                        BindAttributes(
                            propSyntax.Annotations,
                            AttributeTargetKind.Property,
                            Binder.PropertyDeclarationAllowedTargets,
                            "a property declaration",
                            AttributeTargets.Property
                        )
                    )
                    ValidateUnscopedRefPlacement(propertySymbol, structSymbol)
                }
                Binder.AttachDocumentation(propertySymbol, propSyntax)
                staticPropertiesBuilder.Add(propertySymbol)
            }
            structSymbol.SetStaticProperties(staticPropertiesBuilder.ToImmutable())
        }
    }

    private func BindStructSharedEvents(
        syntax StructDeclarationSyntax,
        $package PackageSymbol,
        structSymbol StructSymbol,
        memberBinding StructMemberBindingContext
    ) {
        let existingNames = memberBinding.ExistingNames
        let methodNames = memberBinding.MethodNames
        if syntax.SharedBlock != nil {
            // Static events
            let staticEventsBuilder = ImmutableArray.CreateBuilder[EventSymbol]()
            for eventSyntax in syntax.SharedBlock!!.Events {
                let eventName = eventSyntax.Identifier.ValueText
                if methodNames.Contains(eventName) || !existingNames.Add(eventName) {
                    Diagnostics.ReportSymbolAlreadyDeclared(eventSyntax.Identifier.Location, eventName)
                    continue
                }
                var handlerType TypeSymbol? = if eventSyntax.Type is {} eventTypeSyntax {
                    bindTypeClause(eventTypeSyntax)
                } else {
                    TypeSymbol.Error
                }
                if handlerType == nil {
                    continue
                }
                handlerType = MemberLookup.CanonicalizeWellKnownEventHandler(handlerType)
                let eventAccessibility = resolveAccessibility(eventSyntax.AccessibilityModifier)
                let isFieldLike = eventSyntax.OpenBraceToken == nil
                let eventSymbol = EventSymbol(
                    eventName,
                    handlerType,
                    eventAccessibility,
                    isFieldLike,
                    isVirtual: false,
                    isOverride: false,
                    isStatic: true,
                    declaration: eventSyntax
                )
                if isFieldLike {
                    let backingField = FieldSymbol(
                        eventName,
                        handlerType,
                        Accessibility.Private,
                        isReadOnly: false,
                        isStatic: true,
                        isEventBackingField: true
                    )
                    eventSymbol.BackingField = backingField
                } else {
                    // Issue #257: store explicit accessor bodies for static events.
                    let addAccessor = eventSyntax.Accessors.FirstOrDefault((a EventAccessorSyntax) -> a.IsAdd)
                    let removeAccessor = eventSyntax.Accessors.FirstOrDefault((a EventAccessorSyntax) -> a.IsRemove)
                    let raiseAccessor = eventSyntax.Accessors.FirstOrDefault((a EventAccessorSyntax) -> a.IsRaise)
                    if addAccessor?.Body != nil {
                        eventSymbol.AddBodySyntax = addAccessor.Body
                    }
                    if removeAccessor?.Body != nil {
                        eventSymbol.RemoveBodySyntax = removeAccessor.Body
                    }
                    if raiseAccessor?.Body != nil {
                        eventSymbol.RaiseBodySyntax = raiseAccessor.Body
                    }
                }
                let handlerParam = ParameterSymbol("value", handlerType)
                eventSymbol.AddMethodSymbol = FunctionSymbol(
                    "add_$eventName",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: nil,
                    $package,
                    eventAccessibility,
                    receiverType: default(TypeSymbol?)
                ){IsSpecialName = true, IsUnsafe = binderCtx.InUnsafeContext}
                eventSymbol.AddMethodSymbol!!.IsStatic = true
                eventSymbol.AddMethodSymbol!!.StaticOwnerType = structSymbol
                eventSymbol.RemoveMethodSymbol = FunctionSymbol(
                    "remove_$eventName",
                    ImmutableArray.Create(handlerParam),
                    TypeSymbol.Void,
                    declaration: nil,
                    $package,
                    eventAccessibility,
                    receiverType: default(TypeSymbol?)
                ){IsSpecialName = true, IsUnsafe = binderCtx.InUnsafeContext}
                eventSymbol.RemoveMethodSymbol!!.IsStatic = true
                eventSymbol.RemoveMethodSymbol!!.StaticOwnerType = structSymbol
                // Issue #257: create raise method symbol if raise accessor is present.
                if eventSyntax.Accessors.Any((a EventAccessorSyntax) -> a.IsRaise) {
                    var raiseParams = ImmutableArray[ParameterSymbol].Empty
                    if MemberLookup.TryGetDelegateFunctionTypeFromSymbol(handlerType, out var fnType) {
                        let builder = ImmutableArray.CreateBuilder[ParameterSymbol](fnType.ParameterTypes.Length)
                        for var pi = 0; pi < fnType.ParameterTypes.Length; pi++ {
                            builder.Add(ParameterSymbol("arg$pi", fnType.ParameterTypes[pi]))
                        }
                        raiseParams = builder.ToImmutable()
                    }
                    eventSymbol.RaiseMethodSymbol = FunctionSymbol(
                        "raise_$eventName",
                        raiseParams,
                        TypeSymbol.Void,
                        declaration: nil,
                        $package,
                        eventAccessibility,
                        receiverType: default(TypeSymbol?)
                    ){IsSpecialName = true, IsUnsafe = binderCtx.InUnsafeContext}
                    eventSymbol.RaiseMethodSymbol!!.IsStatic = true
                    eventSymbol.RaiseMethodSymbol!!.StaticOwnerType = structSymbol
                }
                if !eventSyntax.Annotations.IsDefaultOrEmpty {
                    eventSymbol.SetAttributes(
                        BindAttributes(
                            eventSyntax.Annotations,
                            AttributeTargetKind.Event,
                            Binder.EventDeclarationAllowedTargets,
                            "an event declaration",
                            AttributeTargets.Event
                        )
                    )
                }
                Binder.AttachDocumentation(eventSymbol, eventSyntax)
                staticEventsBuilder.Add(eventSymbol)
            }
            structSymbol.SetStaticEvents(staticEventsBuilder.ToImmutable())
        }
    }

    private func RegisterStructConversionOperators(
        $package PackageSymbol,
        declaringType StructSymbol,
        pendingConversionOperators List[
            (
                Syntax FunctionDeclarationSyntax,
                Parameters ImmutableArray[ParameterSymbol],
                ReturnType TypeSymbol,
                Accessibility Accessibility,
                Attributes ImmutableArray[BoundAttribute]
            )
        ]
    ) {
        // Issue #1283: register in-body conversion operators as static
        // `op_Implicit` / `op_Explicit` methods now that the static-method table
        // (which a `shared` block REPLACES via SetStaticMethods above) is final.
        // BindConversionOperatorDeclaration appends via AddStaticMethods, so the
        // operator coexists with any `shared`-block statics.
        for conversionOperator in pendingConversionOperators {
            BindConversionOperatorDeclaration(
                conversionOperator.Syntax,
                conversionOperator.Parameters,
                conversionOperator.ReturnType,
                conversionOperator.Accessibility,
                $package,
                conversionOperator.Attributes,
                declaringType
            )
        }
    }

    private func RegisterStructDeferredInitializers(
        $package PackageSymbol,
        structSymbol StructSymbol,
        fieldBinding StructFieldBindingResult
    ) {
        let pendingConstInitializers = fieldBinding.PendingConstInitializers
        let pendingSharedConstInitializers = fieldBinding.PendingSharedConstInitializers
        let pendingStaticFieldInitializers = fieldBinding.PendingStaticFieldInitializers
        let pendingInstanceInitializers = fieldBinding.PendingInstanceInitializers
        let fields = fieldBinding.Fields
        let primaryCtorParameters = fieldBinding.PrimaryConstructorParameters
        let structDeclaration = structSymbol.Declaration ??
            throw InvalidOperationException("A struct with deferred initializers must have a declaration.")
        // Issue #1070: consolidated field-initializer binding. Every static member
        // symbol of the enclosing type (class const fields, `shared` static fields,
        // `shared` const fields, and static properties) now exists on the struct
        // symbol, so bind ALL deferred initializers in a single scope that exposes
        // those static members by bare name — exactly the visibility a
        // method/constructor body already enjoys (see Binder.BindProgram). This
        // makes a `const`/`shared` field referenced from a field initializer resolve
        // regardless of declaration order, and clears the GS0125 / cascading GS0159
        // diagnostics that previously fired because the static member was not in
        // scope. Instance members remain out of scope (a field initializer has no
        // `this`), so genuine instance-member references are still rejected below.
        // Issue #1194: defer field-initializer binding until after all
        // top-level functions are declared, so a field initializer can resolve
        // an unqualified call to a free function (declared later in
        // Binder.BindGlobalScope) and a sibling static method/const — matching
        // the visibility a constructor body already enjoys. The captured
        // `scope` is the live global scope object into which functions are
        // declared, so by the time this action runs they are present. The
        // enclosing type's static members (fields, consts, static properties,
        // static methods) are exposed by PushStaticMemberScope. Instance
        // members remain out of scope (a field initializer has no `this`), so
        // genuine instance-member references are still rejected below (GS0377).
        let fieldInitScope = $scope
        let fieldInitUnsafeContext = binderCtx.InUnsafeContext
        let fieldInitConstInitializers = pendingConstInitializers
        let fieldInitSharedConstInitializers = pendingSharedConstInitializers
        let fieldInitStaticInitializers = pendingStaticFieldInitializers
        let fieldInitInstanceInitializers = pendingInstanceInitializers
        let fieldInitZeroValueInstanceFields = fieldBinding.PendingZeroValueInstanceFields
        let fieldInitZeroValueStaticFields = fieldBinding.PendingZeroValueStaticFields
        let fieldInitFields = fields.ToImmutable()
        let fieldInitPrimaryCtorParameters = primaryCtorParameters
        let fieldInitPackageName = $package.Name
        pendingFieldInitializerBindings.Add(
            () -> {
                using let unsafeContext = binderCtx.PushUnsafeContext(fieldInitUnsafeContext)
                let savedFieldInitScope = $scope
                let savedFieldInitTypeParameters = binderCtx.CurrentTypeParameters
                let savedFieldInitFunction = getCurrentFunction()
                $scope = fieldInitScope
                // Issue #2342: a deferred field initializer is bound long after the
                // outer per-declaration package-scoped RunWithPackage wrap
                // (Binder.BindGlobalScope) has already unwound, so re-establish
                // this type's OWN owning package as the ambient lookup preference
                // for the duration of this closure — otherwise an unqualified type
                // reference in the initializer could resolve against an unrelated
                // package's same-simple-name homonym.
                let savedFieldInitPackage = $scope.SetCurrentDeclaringPackage(fieldInitPackageName)
                let savedFieldInitTree = $scope.SetCurrentReferencingSyntaxTree(structDeclaration.SyntaxTree)
                // Issue #2111: a static field/property initializer is bound outside
                // any function body, so no "current function" is established. The
                // accessibility gate (AccessibilityChecker) derives the enclosing
                // type from the current function, so without one a `private`/
                // `protected` member of the ENCLOSING type accessed through a
                // type-qualified receiver (`Type.Member`) or a constructor call
                // (`Type()`) is wrongly rejected with GS0472 — even though the
                // initializer belongs to that very type. Establish the enclosing
                // type as the accessibility context for the duration of initializer
                // binding by installing a synthetic static function owned by
                // `structSymbol`, mirroring how a `shared` function body (which
                // already works) carries its `StaticOwnerType`.
                setCurrentFunction(CreateFieldInitializerAccessibilityContext(structSymbol))
                // Issue #3812: this closure runs long after BindStructDeclarationBody
                // unwound its type-parameter scope, so the scope has to be rebuilt
                // from scratch — and it must be rebuilt the SAME way, including the
                // issue #1537 enclosing-type parameters. Seeding only
                // `structSymbol.TypeParameters` left a nested type's initializer
                // unable to name the ENCLOSING type's parameters, so
                // `class Outer[T] { class Inner { var item T = default(T) } }` bound
                // the field's declared type fine (that happens inside the body scope)
                // and then failed on the initializer with GS0113 "Type 'T' doesn't
                // exist" — an initializer-only asymmetry, invisible to any fixture
                // whose nested field had no initializer.
                let initializerEnclosingTypeParameters = CollectEnclosingTypeParameters(structSymbol.ContainingType)
                if !structSymbol.TypeParameters.IsDefaultOrEmpty || initializerEnclosingTypeParameters.Count > 0 {
                    this.binderCtx.CurrentTypeParameters = Dictionary[string, TypeParameterSymbol]()
                    // Outermost-first, so an inner level shadows an outer one on a
                    // name clash — the same precedence BindStructDeclarationBody uses.
                    for tp in initializerEnclosingTypeParameters {
                        binderCtx.CurrentTypeParameters!![tp.Name] = tp
                    }
                    if !structSymbol.TypeParameters.IsDefaultOrEmpty {
                        for tp in structSymbol.TypeParameters {
                            binderCtx.CurrentTypeParameters!![tp.Name] = tp
                        }
                    }
                }
                try {
                    {
                        using let _ = PushStaticMemberScope(structSymbol)
                        BindDeferredFieldInitializers(
                            structSymbol,
                            fieldInitConstInitializers,
                            fieldInitSharedConstInitializers,
                            fieldInitStaticInitializers,
                            fieldInitInstanceInitializers,
                            fieldInitZeroValueInstanceFields,
                            fieldInitZeroValueStaticFields,
                            fieldInitFields,
                            fieldInitPrimaryCtorParameters
                        )
                    }
                } finally {
                    $scope.SetCurrentDeclaringPackage(savedFieldInitPackage)
                    $scope.SetCurrentReferencingSyntaxTree(savedFieldInitTree)
                    $scope = savedFieldInitScope
                    this.binderCtx.CurrentTypeParameters = savedFieldInitTypeParameters
                    setCurrentFunction(savedFieldInitFunction)
                }
            }
        )
    }

    /// Issue #4183: queues a parameter's default-value expression for deferred
    /// binding instead of calling (cref:ConversionClassifier.BindAndAttachParameterDefaultValue)
    /// immediately. Called from every site that used to bind a default value
    /// inline during the per-struct declaration-body pass (primary-constructor
    /// parameters, instance/static method parameters, explicit constructor
    /// parameters) — see (cref:pendingParameterDefaultValueBindings) for
    /// the full rationale and the ordering constraint the drain
    /// ((cref:BindPendingParameterDefaultValues)) must respect.
    /// @param parameterSyntax The parameter syntax carrying the default
    /// clause.
    /// @param parameter The bound parameter symbol to attach the
    /// default to.
    /// @param structSymbol The type declaring the parameter's owning
    /// member; supplies the accessibility context and enclosing/own type
    /// parameters the default-value expression may reference (e.g.
    /// `default(T)`).
    /// @param package The package the declaration belongs to.
    /// @param methodTypeParameters The owning method's OWN generic
    /// type parameters (empty for a non-generic method, a primary
    /// constructor, or an explicit constructor), so a default value may
    /// reference them (e.g. `func M[U](x U = default(U))`).
    private func DeferParameterDefaultValueBinding(
        parameterSyntax ParameterSyntax?,
        parameter ParameterSymbol?,
        structSymbol StructSymbol,
        $package PackageSymbol,
        methodTypeParameters ImmutableArray[TypeParameterSymbol] = default(ImmutableArray[TypeParameterSymbol])
    ) {
        if parameterSyntax == nil || !parameterSyntax.HasDefaultValue || parameter == nil {
            return
        }
        let capturedScope = $scope
        let packageName = $package.Name
        let syntaxTree = parameterSyntax.SyntaxTree
        let enclosingTypeParameters = CollectEnclosingTypeParameters(structSymbol.ContainingType)
        let ownTypeParameters = structSymbol.TypeParameters
        let capturedInUnsafeContext = binderCtx.InUnsafeContext
        pendingParameterDefaultValueBindings.Add(
            () -> {
                let outerScope = $scope
                let outerTypeParameters = binderCtx.CurrentTypeParameters
                let outerFunction = getCurrentFunction()
                $scope = capturedScope
                // Issue #4192 (Copilot finding on #4183): this closure runs after
                // the enclosing `unsafe class` / `unsafe func` scope that was
                // active when the parameter was declared has already unwound
                // (PushUnsafeContext's token is disposed at the end of the
                // per-struct declaration-body pass). An explicit default such as
                // `default(*int32)` re-binds its type clause against
                // binderCtx.InUnsafeContext (see Binder.cs's pointer-type
                // handling), so without restoring it here a pointer-typed default
                // that was valid when declared would be rebound as managed
                // by-ref syntax instead of the raw-pointer type already assigned
                // to the parameter.
                using let unsafeContext = binderCtx.PushUnsafeContext(capturedInUnsafeContext)
                // Issue #2342: re-establish this type's OWN owning package as the
                // ambient lookup preference (mirrors the field-initializer and
                // base-initializer closures above) for the duration of this
                // deferred bind.
                let savedPackage = $scope.SetCurrentDeclaringPackage(packageName)
                let savedTree = $scope.SetCurrentReferencingSyntaxTree(syntaxTree)
                // Issue #2111: install the enclosing type as the accessibility
                // context, mirroring CreateFieldInitializerAccessibilityContext,
                // so a `private`/`protected` static member of the enclosing (or a
                // sibling) type reached from this default-value expression is
                // evaluated against the RIGHT owner instead of whatever function
                // happened to be "current" when this closure eventually runs.
                setCurrentFunction(CreateFieldInitializerAccessibilityContext(structSymbol))
                // Issue #3812: rebuild the type-parameter scope the same way the
                // deferred field-initializer closure does — outermost-enclosing
                // first, then this type's own, then (uniquely for a parameter
                // default) the owning method's own generic type parameters — so a
                // default value referencing `default(T)` / `default(U)` resolves
                // regardless of how long after the original declaration-body pass
                // this closure runs.
                if enclosingTypeParameters.Count > 0 ||
                    !ownTypeParameters.IsDefaultOrEmpty ||
                    !methodTypeParameters
                    .IsDefaultOrEmpty {
                    let typeParameterScope = Dictionary[string, TypeParameterSymbol]()
                    for tp in enclosingTypeParameters {
                        typeParameterScope[tp.Name] = tp
                    }
                    if !ownTypeParameters.IsDefaultOrEmpty {
                        for tp in ownTypeParameters {
                            typeParameterScope[tp.Name] = tp
                        }
                    }
                    if !methodTypeParameters.IsDefaultOrEmpty {
                        for tp in methodTypeParameters {
                            typeParameterScope[tp.Name] = tp
                        }
                    }
                    this.binderCtx.CurrentTypeParameters = typeParameterScope
                } else {
                    this.binderCtx.CurrentTypeParameters = nil
                }
                try {
                    conversions.BindAndAttachParameterDefaultValue(parameterSyntax, parameter)
                } finally {
                    $scope.SetCurrentDeclaringPackage(savedPackage)
                    $scope.SetCurrentReferencingSyntaxTree(savedTree)
                    $scope = outerScope
                    this.binderCtx.CurrentTypeParameters = outerTypeParameters
                    setCurrentFunction(outerFunction)
                }
            }
        )
    }

    /// Issue #4183: binds every deferred parameter default-value expression,
    /// run from `Binder.BindGlobalScope` after every struct's static-member
    /// surface exists compilation-wide (alongside — immediately before —
    /// (cref:BindPendingFieldInitializers)), and BEFORE
    /// `BindPendingBaseInitializers` so that
    /// (cref:ParameterSymbol.HasExplicitDefaultValue) is already
    /// populated by the time a `: base(...)` initializer resolves against a
    /// base constructor's optional trailing parameters.
    internal func BindPendingParameterDefaultValues() {
        for bind in pendingParameterDefaultValueBindings {
            bind()
        }
        pendingParameterDefaultValueBindings.Clear()
    }

    /// Issue #4481: decides, once every type body is bound, whether each
    /// get-only property override whose type differs from its base property's
    /// is a covariant narrowing. A narrowing keeps its overridden-property
    /// link, from which the emitter gives the getter a new slot bound to the
    /// base getter by a MethodImpl (#4508); anything else has no CLR override
    /// form, loses the link, and reports GS0185.
    internal func CheckPendingCovariantPropertyOverrides() {
        for check in pendingCovariantPropertyOverrideChecks {
            check()
        }
        pendingCovariantPropertyOverrideChecks.Clear()
    }

    private func RegisterCovariantPropertyOverrideCheck(propertySymbol PropertySymbol, location TextLocation) {
        pendingCovariantPropertyOverrideChecks.Add(
            () -> {
                // The emitter classifies with this same predicate, so an override
                // accepted here is always given its MethodImpl.
                if propertySymbol.OverriddenProperty is {} baseProperty &&
                    IsCovariantPropertyOverride(
                    baseProperty,
                    propertySymbol.Type,
                    propertySymbol.HasGetter,
                    propertySymbol.HasSetter,
                    propertySymbol.ReturnRefKind
                ) {
                    return
                }
                propertySymbol.OverriddenProperty = nil
                Diagnostics.ReportOverrideSignatureMismatch(location, propertySymbol.Name)
            }
        )
    }

    private func RegisterStructInterfaceChecks(
        syntax StructDeclarationSyntax,
        structSymbol StructSymbol,
        baseBinding StructBaseBindingResult
    ) {
        let implementedInterfaces = baseBinding.ImplementedInterfaces
        let implementedClrInterfaces = baseBinding.ImplementedClrInterfaces
        // ADR-0199: every data type implements IEquatable<Self> through its
        // compiler-owned typed Equals slot, as a C# record does. A declared
        // `IEquatable[Self]` is the same interface and is not repeated.
        if structSymbol.IsData && !DataEqualityMemberModel.ListsSelfEquatable(structSymbol, implementedClrInterfaces) {
            implementedClrInterfaces.Add(DataEqualityMemberModel.CreateSelfEquatable(structSymbol))
        }
        // Phase 3.B.4: validate interface implementation. Walks each
        // implemented interface and confirms the class (including inherited
        // methods) provides a same-name, same-signature method. The check
        // itself is deferred (see `VerifyInterfaceImplementations`) until
        // after interface method signatures have been bound, since
        // interface methods may forward-reference user struct/class types.
        if implementedInterfaces.Count > 0 {
            structSymbol.SetInterfaces(implementedInterfaces.ToImmutable())
            for iface in implementedInterfaces {
                // Phase 3.B.5: a `sealed` interface restricts implementors
                // to the same package as the interface itself.
                if iface.IsSealed && !string.Equals(
                    iface.PackageName ?? string.Empty,
                    structSymbol.PackageName ?? string.Empty,
                    StringComparison.Ordinal
                ) {
                    Diagnostics.ReportSealedInterfaceImplementorOutsidePackage(
                        syntax.Identifier.Location,
                        structSymbol,
                        iface.Name,
                        iface.PackageName ?? string.Empty
                    )
                }
            }
            pendingInterfaceImplementationChecks.Add((syntax, structSymbol))
        }
        // Issue #525: record imported CLR interfaces from the base-type
        // clause and queue the same deferred verification used for G#
        // interfaces. The check is deferred because class methods may not
        // have been bound yet when this declaration is processed.
        if implementedClrInterfaces.Count > 0 {
            structSymbol.SetImplementedClrInterfaces(implementedClrInterfaces.ToImmutable())
            if implementedInterfaces.Count == 0 {
                pendingInterfaceImplementationChecks.Add((syntax, structSymbol))
            }
        }
        // ADR-0149: a type that declares an explicit-interface qualifier
        // clause (`func (X) M(...)` / `prop (X) P T` / `event (X) E T` /
        // a STATIC method or property inside a `shared { }` block, per the
        // #2370 "final completion pass" generalization) but implements NO
        // interface at all (neither G# nor CLR) would otherwise never reach
        // ResolveExplicitInterfaceClauses/VerifyExplicitInterfaceClauseResolution
        // (both driven off pendingInterfaceImplementationChecks) — silently
        // compiling the clause away as a no-op instead of reporting GS0492/
        // GS0493. Queue it too, purely so its clause(s) still get resolved
        // and diagnosed; with zero implemented interfaces, a non-interface
        // clause type is still caught by GS0492, and any interface type
        // (valid or not) is correctly rejected by GS0493 ("does not
        // implement interface X") since structSymbol.Interfaces is empty.
        // (Originally only checked Methods/Properties; Events and the STATIC
        // Methods/Properties collections had the identical gap — an explicit
        // clause on an event or static member of an interface-less type
        // silently compiled with no diagnostic at all — fixed here.)
        if implementedInterfaces.Count == 0 &&
            implementedClrInterfaces.Count == 0 &&
            (
            HasAnyExplicitInterfaceClause(structSymbol.Methods) ||
                HasAnyExplicitInterfaceClause(structSymbol.Properties) ||
                HasAnyExplicitInterfaceClause(structSymbol.Events) ||
                HasAnyExplicitInterfaceClause(structSymbol.StaticMethods) ||
                HasAnyExplicitInterfaceClause(structSymbol.StaticProperties)
        ) {
            pendingInterfaceImplementationChecks.Add((syntax, structSymbol))
        }
    }

    private func BindStructFinalMembers(
        syntax StructDeclarationSyntax,
        $package PackageSymbol,
        structSymbol StructSymbol,
        baseBinding StructBaseBindingResult
    ) {
        let baseClassSymbol = baseBinding.BaseClass
        let importedBaseType = baseBinding.ImportedBaseType
        // Issue #306: bind standalone user-defined constructors (`init(...)`).
        BindConstructorDeclarations(syntax, structSymbol, $package, baseClassSymbol, importedBaseType)
        // ADR-0068 / issue #698: bind the optional class destructor (`deinit { … }`).
        BindDeinitDeclaration(syntax, structSymbol, $package)
        if DataEqualityMemberModel.GetSealedIntermediaryOverride(structSymbol) is {} sealedEquality {
            Diagnostics.ReportOverrideOfSealedMethod(syntax.Identifier.Location, sealedEquality.Name)
        }
        // ADR-0199: the synthesized print-members override cannot override a
        // sealed override declared by an intermediary class.
        if structSymbol.IsData && DataPrintMembersModel.FindDeclared(structSymbol) == nil &&
            DataPrintMembersModel.GetSealedBaseSlot(structSymbol) is {} sealedPrintMembers {
            Diagnostics.ReportOverrideOfSealedMethod(syntax.Identifier.Location, sealedPrintMembers.Name)
        }
        // Issue #910 / ADR-0110 / issue #1069: bind the BODIES of the nested type
        // declarations declared inside this aggregate's body. Their type-name
        // shells were declared earlier (DeclareNestedTypeShells) so sibling
        // member signatures could forward-reference them; here we fill in their
        // members. The emitter materialises real CLR nested types.
        BindNestedTypeBodies(syntax, $package)
        // Issue #987: queue the abstract-member contract check for classes. A
        // concrete (non-`open`) class with a base must override every inherited
        // abstract method; deferred so base-class methods are bound first.
        if syntax.IsClass {
            pendingAbstractImplementationChecks.Add((syntax, structSymbol))
        }
    }

    /// ADR-0122 §10 / issue #1035: synthesizes the compiler-generated nested
    /// backing struct for a fixed-size buffer field. The struct carries a
    /// single element field `FixedElementField` of type `T` and an
    /// explicit sequential `ClassLayout` size of `N * sizeof(T)`,
    /// mirroring how C# / Roslyn lowers a `fixed T name[N]` buffer. The
    /// struct is registered in the root scope so it flows through the normal
    /// nested-type emission pipeline.
    /// @param containingType The struct that declares the fixed buffer.
    /// @param fieldName The fixed-buffer field name.
    /// @param elementType The buffer element type `T`.
    /// @param length The element count `N`.
    /// @param elementSize The element size in bytes.
    /// @param package The owning package.
    /// @returns The synthesized backing (cref:StructSymbol).
    private func SynthesizeFixedBufferBackingStruct(
        containingType StructSymbol,
        fieldName string,
        elementType TypeSymbol,
        length int32,
        elementSize int32,
        $package PackageSymbol
    ) StructSymbol {
        let bufferName = "<$fieldName>e__FixedBuffer"
        let elementField = FieldSymbol("FixedElementField", elementType, Accessibility.Public, isReadOnly: false)
        let backing = StructSymbol(
            bufferName,
            ImmutableArray.Create(elementField),
            Accessibility.Public,
            declaration: nil,
            packageName: $package?.Name ?? string.Empty,
            isData: false,
            isInline: false,
            isClass: false,
            primaryConstructorParameters: ImmutableArray[ParameterSymbol].Empty
        )
        backing.SetContainingType(containingType)
        backing.MarkFixedBufferBacking(elementType)
        backing.SetLayoutMetadata(StructLayoutMetadata(LayoutKind.Sequential, pack: nil, size: length * elementSize))
        // Register the backing struct so GetDeclaredStructs() surfaces it to the
        // emitter, where it is emitted as a nested TypeDef of the containing type.
        $scope.TryDeclareTypeAlias(bufferName, backing)
        return backing
    }

    private func BindConstFieldInitializer(
        constField FieldSymbol,
        fieldSyntaxNode FieldDeclarationSyntax,
        fieldType TypeSymbol
    )(Field FieldSymbol, Bound BoundExpression, Location TextLocation) {
        let initializer = fieldSyntaxNode.Initializer ??
            throw InvalidOperationException("A deferred const field initializer must have an initializer expression.")
        let boundInit = if initializer is BlockExpressionSyntax {
            conversions.BindConversion(initializer, fieldType)
        } else {
            bindExpression(initializer)
        }
        let convertedInit = if initializer is BlockExpressionSyntax {
            boundInit
        } else {
            conversions.BindConversion(initializer.Location, boundInit, fieldType)
        }
        var bound = if boundInit is BoundErrorExpression || convertedInit is BoundErrorExpression {
            cast[BoundExpression](BoundErrorExpression(initializer))
        } else {
            convertedInit
        }
        if !(bound is BoundErrorExpression) && ConstantExpressionEvaluator.TryFindNativeInteger(
            bound,
            out var nativeType
        ) {
            Diagnostics.ReportConstNativeIntegerNotSupported(
                fieldSyntaxNode.Identifier.Location,
                constField.Name,
                Invariant.Required(nativeType, "a detected native integer has a type", expression: "nativeType").Name
            )
            bound = BoundErrorExpression(initializer)
        }
        return (constField, bound, initializer.Location)
    }

    /// Issue #1070: pushes a child scope that exposes the enclosing type's static
    /// members — static fields, const fields, and static properties — as bare
    /// names, then makes it the active binding scope. This mirrors the
    /// static-member visibility that method/constructor bodies already have (see
    /// `Binder.BindProgram`), so a field initializer (instance
    /// `let`/`var`, `shared` field, or `const`) can reference a
    /// sibling `const` or `shared` field regardless of declaration order.
    /// The returned token restores the previous scope when disposed.
    private func PushStaticMemberScope(structSymbol StructSymbol) StaticMemberScope {
        let previous = binderCtx.RootScope
        let staticScope = BoundScope(previous)
        if !structSymbol.StaticFields.IsDefaultOrEmpty {
            for fld in structSymbol.StaticFields {
                staticScope.TryDeclareVariable(ImplicitStaticFieldVariableSymbol(structSymbol, fld))
            }
        }
        if !structSymbol.ConstFields.IsDefaultOrEmpty {
            for fld in structSymbol.ConstFields {
                staticScope.TryDeclareVariable(ImplicitStaticFieldVariableSymbol(structSymbol, fld))
            }
        }
        if !structSymbol.StaticProperties.IsDefaultOrEmpty {
            for prop in structSymbol.StaticProperties {
                staticScope.TryDeclareVariable(ImplicitStaticPropertyVariableSymbol(structSymbol, prop))
            }
        }
        // Issue #1194: expose the enclosing type's static methods by bare name so
        // a field/const/base initializer can call a sibling `static` method
        // unqualified (matching C#). Declared as functions in the innermost
        // scope, they shadow any same-named free function — the C# member-lookup
        // order — and resolve through the normal free-function call path, which
        // emits a static call on the owning method.
        if !structSymbol.StaticMethods.IsDefaultOrEmpty {
            for method in structSymbol.StaticMethods {
                staticScope.TryDeclareFunction(method)
            }
        }
        this.binderCtx.RootScope = staticScope
        return StaticMemberScope(binderCtx, previous)
    }

    /// Issue #1070: restores the binder's root scope to the value captured before
    /// (cref:PushStaticMemberScope) installed the static-member scope.
    private struct StaticMemberScope : IDisposable {
        private let binderCtx BinderContext
        private let previous BoundScope

        init(binderCtx BinderContext, previous BoundScope) {
            this.binderCtx = binderCtx
            this.previous = previous
        }

        func Dispose() -> this.binderCtx.RootScope = previous
    }

    /// Issue #910 / ADR-0110 / issue #1069: binds the BODIES of the nested type
    /// declarations declared in a class or struct body, reusing the type-name
    /// shells declared earlier by (cref:DeclareNestedTypeShells) (phase 1).
    /// Splitting shell declaration from body binding lets a sibling member
    /// signature (a field/property/parameter/return type, a generic argument, an
    /// array element type, …) forward-reference any nested type by simple name,
    /// for every nested kind (`class`/`struct`/`data struct`/
    /// `interface`/`enum`). Nested enums are fully bound in the shell
    /// phase (their members reference no user types) and need no body pass here.
    /// Nested-in-nested declarations are handled recursively because the
    /// per-kind body binders bind their own nested types.
    ///
    /// All nested kinds inside either encloser (`class` or `struct`)
    /// are emitted as real CLR nested types. The emitter materialises every
    /// enclosing TypeDef row before its nested rows (ECMA-335 §II.22.32) via a
    /// unified pre-order emission pass (ADR-0110), so no kind/encloser
    /// combination needs to be deferred.
    private func BindNestedTypeBodies(containerSyntax StructDeclarationSyntax, $package PackageSymbol) {
        if containerSyntax.NestedTypes.IsDefaultOrEmpty {
            return
        }
        for nested in containerSyntax.NestedTypes {
            // Issue #950: a `protected` nested type is only meaningful when the
            // container is an inheritable `open class`. Otherwise nothing can
            // derive from the container to reach the nested type.
            if !(containerSyntax.IsClass && (containerSyntax.IsOpen || containerSyntax.IsAbstract)) {
                ReportProtectedToken(GetMemberAccessibilityModifier(nested))
            }
            switch nested {
                case nestedStruct is StructDeclarationSyntax {
                    // The shell (and its own nested shells, recursively) was
                    // declared in phase 1; bind its body now. Binding the body
                    // recurses into BindNestedTypeBodies for nested-in-nested.
                    if nestedStructShells.TryGetValue(nestedStruct, out var nestedStructSymbol) {
                        BindStructDeclarationBody(nestedStruct, $package, nestedStructSymbol)
                    }
                }
                case EnumDeclarationSyntax { }
                case nestedInterface is InterfaceDeclarationSyntax {
                    if nestedInterfaceShells.TryGetValue(nestedInterface, out var nestedInterfaceSymbol) {
                        BindInterfaceMembers(nestedInterface, nestedInterfaceSymbol, $package)
                    }
                }
            }
        }
    }

    /// Issue #1069 (phase 1): declares the type-name shells of the nested types
    /// declared in [`containerSyntax`](paramref) and records the enclosing
    /// type on each via `SetContainingType`, BEFORE any member body of the
    /// enclosing type is bound. This makes every nested type resolvable by simple
    /// name from within the enclosing type (and as a CLR nested type by qualified
    /// name from outside) regardless of declaration order, mirroring the
    /// two-phase scheme used for top-level types (#973).
    /// - `struct`/`class`/`data struct`: a shell is declared (fields/base bound later) and its own nested
    /// shells are declared recursively.
    /// - `enum`: fully bound now — enum members reference no user types, so there is nothing to defer.
    /// - `interface`: a shell is declared; its method signatures are bound later by
    /// (cref:BindNestedTypeBodies).
    internal func DeclareNestedTypeShells(
        containerSyntax StructDeclarationSyntax,
        containerSymbol TypeSymbol,
        $package PackageSymbol
    ) {
        if containerSyntax.NestedTypes.IsDefaultOrEmpty {
            return
        }
        for nested in containerSyntax.NestedTypes {
            switch nested {
                case nestedStruct is StructDeclarationSyntax {
                    let nestedStructSymbol StructSymbol? = DeclareStructShell(nestedStruct, $package, containerSymbol)
                    if nestedStructSymbol != nil {
                        nestedStructShells[nestedStruct] = nestedStructSymbol
                        DeclareNestedTypeShells(nestedStruct, nestedStructSymbol, $package)
                    }
                }
                case nestedEnum is EnumDeclarationSyntax {
                    BindEnumDeclaration(nestedEnum, $package, containerSymbol)
                }
                case nestedInterface is InterfaceDeclarationSyntax {
                    let nestedInterfaceSymbol InterfaceSymbol? = DeclareInterfaceSymbol(
                        nestedInterface,
                        $package,
                        containerSymbol
                    )
                    if nestedInterfaceSymbol != nil {
                        nestedInterfaceShells[nestedInterface] = nestedInterfaceSymbol
                    }
                }
            }
        }
    }

    // Issue #1085: run all deferred base-constructor-initializer bindings. Must
    // be called after every declared type body has been bound (so all explicit
    // constructors exist) and before lowering/emit consume the resolved
    // initializers.
    /// Issue #987: verifies that every concrete (non-`open`) class
    /// overrides all abstract methods it inherits. Run after all type bodies are
    /// bound so the base-class method sets are complete. An `open` class may
    /// leave inherited abstract members unimplemented (it stays abstract itself).
    internal func BindPendingBaseInitializers() {
        for bind in pendingBaseInitializerBindings {
            bind()
        }
        pendingBaseInitializerBindings.Clear()
    }

    /// Issue #1194: binds the deferred field-initializer expressions for every
    /// type, run from `Binder.BindGlobalScope` after all top-level
    /// functions have been declared so a field initializer can resolve an
    /// unqualified free-function or sibling static-member call.
    internal func BindPendingFieldInitializers() {
        for bind in pendingFieldInitializerBindings {
            bind()
        }
        pendingFieldInitializerBindings.Clear()
        FoldCrossTypeConstInitializers()
    }

    /// Issue #3896: the compilation-wide const fixpoint. Every const initializer
    /// that its own type's fixpoint (#1193) could not fold lands here, because
    /// the value it references may live in a type whose initializers were bound
    /// later. Retrying across all types makes `const` references order
    /// independent between types exactly as they already are within one; only a
    /// const still unfolded after this pass is genuinely non-constant (or part
    /// of a cycle) and reported with GS0376.
    private func FoldCrossTypeConstInitializers() {
        var pending = List[(Field FieldSymbol, Bound BoundExpression, Location TextLocation)](
            pendingCrossTypeConstFolds
        )
        pendingCrossTypeConstFolds.Clear()
        var progress = true
        while progress && pending.Count > 0 {
            progress = false
            let stillPending = List[(Field FieldSymbol, Bound BoundExpression, Location TextLocation)]()
            for item in pending {
                if ConstantExpressionEvaluator.TryFold(item.Bound, item.Field.Type, out var constantValue) {
                    item.Field.SetConstantValue(constantValue)
                    progress = true
                } else {
                    stillPending.Add(item)
                }
            }
            pending = stillPending
        }
        for (constField, bound, location) in pending {
            if !(bound is BoundErrorExpression) {
                Diagnostics.ReportConstFieldInitializerNotConstant(location, constField.Name)
            }
        }
    }

    /// Issue #1194: binds a single type's deferred field/const/static
    /// initializers within the active static-member scope. Const initializers
    /// are folded with a fixpoint so sibling const references resolve regardless
    /// of declaration order (#1193); instance initializers reject instance
    /// member references (no `this` is available, GS0377).
    private func BindDeferredFieldInitializers(
        structSymbol StructSymbol,
        constInitializers List[(Field FieldSymbol, Syntax FieldDeclarationSyntax, FieldType TypeSymbol)],
        sharedConstInitializers List[(Field FieldSymbol, Syntax FieldDeclarationSyntax, FieldType TypeSymbol)],
        staticFieldInitializers List[(Field FieldSymbol, InitSyntax ExpressionSyntax, FieldType TypeSymbol)],
        instanceInitializers List[(Field FieldSymbol, InitSyntax ExpressionSyntax, FieldType TypeSymbol)],
        zeroValueInstanceFields List[(Field FieldSymbol, Syntax SyntaxNode)],
        zeroValueStaticFields List[(Field FieldSymbol, Syntax SyntaxNode)],
        fields ImmutableArray[FieldSymbol],
        primaryCtorParameters ImmutableArray[ParameterSymbol]
    ) {
        // Fold const initializers with a fixpoint so a const that references a
        // sibling const folds regardless of declaration order (#1193). Each
        // initializer is bound exactly once (binding a const reference does not
        // require its value), then folding is retried until no further progress.
        // Class const initializers are seeded first so a `shared` const
        // referencing a class const can read its value.
        var pendingConstFolds = List[(Field FieldSymbol, Bound BoundExpression, Location TextLocation)]()
        for (constField, fieldSyntaxNode, fieldType) in constInitializers {
            pendingConstFolds.Add(BindConstFieldInitializer(constField, fieldSyntaxNode, fieldType))
        }
        for (constField, fieldSyntaxNode, fieldType) in sharedConstInitializers {
            pendingConstFolds.Add(BindConstFieldInitializer(constField, fieldSyntaxNode, fieldType))
        }
        var progress = true
        while progress && pendingConstFolds.Count > 0 {
            progress = false
            let stillPending = List[(Field FieldSymbol, Bound BoundExpression, Location TextLocation)]()
            for item in pendingConstFolds {
                if ConstantExpressionEvaluator.TryFold(item.Bound, item.Field.Type, out var constantValue) {
                    item.Field.SetConstantValue(constantValue)
                    progress = true
                } else {
                    stillPending.Add(item)
                }
            }
            pendingConstFolds = stillPending
        }
        // Issue #3896: what is still pending here may be waiting on a const in
        // ANOTHER type that has not been folded yet — the per-type fixpoint
        // above cannot see it, and this method runs once per type in
        // declaration order, so `class B { const X = A.Y }` failed with GS0376
        // whenever A's initializers were bound after B's. Const references are
        // order independent in C# and in G#, so the leftovers are handed to a
        // compilation-wide fixpoint that BindPendingFieldInitializers runs once
        // every type's initializers are bound; that pass, not this one, reports
        // the const that genuinely cannot fold.
        pendingCrossTypeConstFolds.AddRange(pendingConstFolds)
        // Bind `shared` static field initializers.
        if staticFieldInitializers.Count > 0 || zeroValueStaticFields.Count > 0 {
            let previousFunction = getCurrentFunction()
            let staticInitializerContext = CreateFieldInitializerAccessibilityContext(structSymbol)
            staticInitializerContext.IsStaticInitializer = true
            setCurrentFunction(staticInitializerContext)
            try {
                let staticInitBuilder = ImmutableDictionary.CreateBuilder[FieldSymbol, BoundExpression]()
                for (fieldSym, initSyntax, fieldType) in staticFieldInitializers {
                    let boundInit = if initSyntax is BlockExpressionSyntax {
                        conversions.BindConversion(initSyntax, fieldType)
                    } else {
                        bindExpression(initSyntax)
                    }
                    let convertedInit = if initSyntax is BlockExpressionSyntax {
                        boundInit
                    } else {
                        conversions.BindConversion(initSyntax.Location, boundInit, fieldType)
                    }
                    // Issue #4453: an initializer is class code too, so the
                    // protected-receiver rule applies to it.
                    ProtectedReceiverDiagnostics.Report(convertedInit, staticInitializerContext, Diagnostics)
                    staticInitBuilder[fieldSym] = convertedInit
                }
                // Issue #3310 / ADR-0159 (extended by #3319): synthesized
                // empty-instance zero values for initializer-less static
                // collection fields, including struct-typed fields whose own
                // fields (recursively) need one. This pass runs after every
                // struct in the compilation has its fields bound, so the
                // recursion in TrySynthesizeEmptyInstance is safe here — a
                // struct-typed candidate that turns out to need nothing
                // (null result) is simply skipped, leaving it out of
                // StaticFieldInitializers exactly as before #3319.
                for (fieldSym, fieldSyntaxNode) in zeroValueStaticFields {
                    let zeroValue BoundExpression? = MagicCollectionZeroValue.TrySynthesizeEmptyInstance(
                        fieldSyntaxNode,
                        fieldSym.Type,
                        out var missingDeclarationShape
                    )
                    if missingDeclarationShape {
                        Diagnostics.ReportNoApplicableOverload(fieldSyntaxNode.Location, fieldSym.Type.ToString())
                    }
                    if zeroValue != nil {
                        staticInitBuilder[fieldSym] = zeroValue
                    }
                }
                structSymbol.SetStaticFieldInitializers(staticInitBuilder.ToImmutable())
            } finally {
                setCurrentFunction(previousFunction)
            }
        }
        // Bind instance field initializers. Primary-constructor parameters are
        // available because their same-named fields are assigned first.
        if instanceInitializers.Count > 0 || zeroValueInstanceFields.Count > 0 {
            let instanceMemberNames = HashSet[string](StringComparer.Ordinal){"this"}
            let primaryCtorParameterNames = HashSet[string](
                primaryCtorParameters.Select((parameter ParameterSymbol) -> parameter.Name),
                StringComparer.Ordinal
            )
            for f in fields {
                if !primaryCtorParameterNames.Contains(f.Name) {
                    instanceMemberNames.Add(f.Name)
                }
            }
            let savedInstanceInitializerScope = $scope
            $scope = BoundScope($scope)
            for primaryCtorParameter in primaryCtorParameters {
                $scope.TryDeclareVariable(primaryCtorParameter)
            }
            try {
                let instanceInitBuilder = ImmutableDictionary.CreateBuilder[FieldSymbol, BoundExpression]()
                for (fieldSym, initSyntax, fieldType) in instanceInitializers {
                    if TryFindInstanceMemberReference(
                        initSyntax,
                        instanceMemberNames,
                        out var offendingName,
                        out var offendingLocation
                    ) {
                        if offendingName is {} memberName {
                            Diagnostics.ReportFieldInitializerCannotReferenceInstanceMember(
                                offendingLocation,
                                memberName
                            )
                        }
                        continue
                    }
                    let boundInit = if initSyntax is BlockExpressionSyntax {
                        conversions.BindConversion(initSyntax, fieldType)
                    } else {
                        bindExpression(initSyntax)
                    }
                    let convertedInit = if initSyntax is BlockExpressionSyntax {
                        boundInit
                    } else {
                        conversions.BindConversion(initSyntax.Location, boundInit, fieldType)
                    }
                    // Issue #4453: see the static initializers above.
                    ProtectedReceiverDiagnostics.Report(convertedInit, getCurrentFunction(), Diagnostics)
                    instanceInitBuilder[fieldSym] = convertedInit
                }
                for (fieldSym, fieldSyntaxNode) in zeroValueInstanceFields {
                    let zeroValue BoundExpression? = MagicCollectionZeroValue.TrySynthesizeEmptyInstance(
                        fieldSyntaxNode,
                        fieldSym.Type,
                        out var missingDeclarationShape
                    )
                    if missingDeclarationShape {
                        Diagnostics.ReportNoApplicableOverload(fieldSyntaxNode.Location, fieldSym.Type.ToString())
                    }
                    if zeroValue != nil {
                        instanceInitBuilder[fieldSym] = zeroValue
                    }
                }
                structSymbol.SetInstanceFieldInitializers(instanceInitBuilder.ToImmutable())
            } finally {
                $scope = savedInstanceInitializerScope
            }
        }
    }

    shared {
        /// Issue #1537: collects the type parameters of [`enclosingType`](paramref)
        /// and all of ITS enclosing types, outermost-first, so a nested type's
        /// members and its own type-parameter constraints can reference them.
        /// Returns an empty list for a top-level type ([`enclosingType`](paramref)
        /// is `null`) or when every encloser is non-generic.
        /// @param enclosingType The immediately enclosing type, or `null`.
        /// @returns The enclosing type parameters, outermost-first.
        private func CollectEnclosingTypeParameters(enclosingType TypeSymbol?) List[TypeParameterSymbol] {
            var levels List[ImmutableArray[TypeParameterSymbol]]? = nil
            for var c StructSymbol? = enclosingType as StructSymbol; c != nil; c = c!!.ContainingType as StructSymbol {
                if !c.TypeParameters.IsDefaultOrEmpty {
                    levels ??= List[ImmutableArray[TypeParameterSymbol]]()
                    // Prepend so the outermost enclosing type's parameters come first.
                    levels!!.Insert(0, c.TypeParameters)
                }
            }
            let result = List[TypeParameterSymbol]()
            if levels != nil {
                for level in levels {
                    result.AddRange(level)
                }
            }
            return result
        }

        private func GetMemberAccessibilityModifier(member MemberSyntax) SyntaxToken? -> switch member {
            case s is StructDeclarationSyntax: s.AccessibilityModifier
            case e is EnumDeclarationSyntax: e.AccessibilityModifier
            case i is InterfaceDeclarationSyntax: i.AccessibilityModifier
            case d is DelegateDeclarationSyntax: d.AccessibilityModifier
            default: default(SyntaxToken?)
        }

        /// ADR-0192: whether two bound attributes are the same application —
        /// target, attribute type, and every positional and named argument's name,
        /// type, and value. Identical annotation text can still bind differently
        /// per file (`typeof(Timer)` under two different imports), so
        /// comparing only the attribute type is not enough (Copilot review round 13).
        private func BoundAttributesEquivalent(
            left BoundAttribute,
            right BoundAttribute
        ) bool -> left.Target == right.Target &&
            TypeSignaturesEquivalent(left.AttributeType, right.AttributeType) &&
            BoundAttributeArgumentsEquivalent(left.PositionalArguments, right.PositionalArguments) &&
            BoundAttributeArgumentsEquivalent(left.NamedArguments, right.NamedArguments)

        private func BoundAttributeArgumentsEquivalent(
            left ImmutableArray[BoundAttributeArgument],
            right ImmutableArray[BoundAttributeArgument]
        ) bool {
            var left = left
            var right = right
            left = if left.IsDefault {
                ImmutableArray[BoundAttributeArgument].Empty
            } else {
                left
            }
            right = if right.IsDefault {
                ImmutableArray[BoundAttributeArgument].Empty
            } else {
                right
            }
            if left.Length != right.Length {
                return false
            }
            for var i = 0; i < left.Length; i++ {
                if !string.Equals(left[i].Name, right[i].Name, StringComparison.Ordinal) ||
                    !TypeSignaturesEquivalent(left[i].Type, right[i].Type) ||
                    !BoundAttributeValuesEquivalent(left[i].Value, right[i].Value) {
                    return false
                }
            }
            return true
        }

        /// Compares attribute argument values: a `typeof` naming a source type
        /// is carried as its (cref:TypeSymbol), an array as a CLR array whose
        /// elements may themselves be nested arguments, and everything else as a
        /// constant compared with (cref:object.Equals(object, object)).
        private func BoundAttributeValuesEquivalent(left object?, right object?) bool -> switch (left, right) {
            case {Item1: nil, Item2: nil}: true
            case {Item1: leftType is TypeSymbol, Item2: rightType is TypeSymbol}: TypeSignaturesEquivalent(
                leftType,
                rightType
            )
            case {
                Item1: leftArgument is BoundAttributeArgument,
                Item2: rightArgument is BoundAttributeArgument
            }: TypeSignaturesEquivalent(leftArgument.Type, rightArgument.Type) &&
                BoundAttributeValuesEquivalent(leftArgument.Value, rightArgument.Value)
            case {Item1: leftArray is Array, Item2: rightArray is Array}: leftArray.Length == rightArray.Length &&
                Enumerable
                .Range(0, leftArray.Length).All(
                (i int32) -> BoundAttributeValuesEquivalent(leftArray.GetValue(i), rightArray.GetValue(i))
            )
            default: object.Equals(left, right)
        }

        private func CanonicalizeInterfaceEventHandlerType(
            baseBinding StructBaseBindingResult,
            eventName string,
            handlerType TypeSymbol
        ) TypeSymbol {
            if !(handlerType is FunctionTypeSymbol) {
                return handlerType
            }
            var selected TypeSymbol? = nil
            var ambiguous = false
            let Consider = func (expected TypeSymbol) {
                if !MemberLookup.TryCanonicalizeStructuralFunctionType(handlerType, expected, out var canonical) {
                    return
                }
                if selected == nil {
                    selected = canonical
                } else if !NamedDelegateIdentitiesMatch(selected, canonical) {
                    ambiguous = true
                }
            }
            for iface in baseBinding.ImplementedInterfaces {
                for interfaceEvent in(iface.Definition ?? iface).Events {
                    if interfaceEvent.Name == eventName {
                        Consider(interfaceEvent.Type)
                    }
                }
            }
            for ifaceSymbol in baseBinding.ImplementedClrInterfaces {
                let declaredInterface = ifaceSymbol.ClrType
                if declaredInterface?.IsInterface != true {
                    continue
                }
                let interfaces = List[Type]{declaredInterface}
                interfaces.AddRange(declaredInterface!!.GetInterfaces())
                for clrInterface in interfaces {
                    let containingType = if object.ReferenceEquals(clrInterface, declaredInterface) {
                        ifaceSymbol
                    } else {
                        TypeSymbol.FromClrTypeWithoutNullability(clrInterface, NullabilityFreeReason.TypeStructure)
                    }
                    for interfaceEvent in clrInterface.GetEvents(
                        BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
                    ) {
                        if interfaceEvent.Name == eventName {
                            Consider(MemberLookup.GetClrEventHandlerTypeSymbol(containingType, interfaceEvent))
                        }
                    }
                }
            }
            return if ambiguous {
                handlerType
            } else {
                selected ?? handlerType
            }
        }

        private func NamedDelegateIdentitiesMatch(left TypeSymbol, right TypeSymbol) bool {
            if object.ReferenceEquals(left, right) {
                return true
            }
            if left is DelegateTypeSymbol && right is DelegateTypeSymbol {
                return TypeSignaturesEquivalent(left, right)
            }
            return left?.ClrType != nil && right?.ClrType != nil && ClrTypeUtilities.AreSame(
                left.ClrType,
                right.ClrType
            )
        }

        /// Issue #2111: builds the synthetic static function used as the
        /// accessibility context while binding a type's deferred static/instance
        /// field and property initializers. The function carries no body and is
        /// never emitted; its sole purpose is to expose [`owner`](paramref) as
        /// the enclosing type (via (cref:FunctionSymbol.StaticOwnerType)) so
        /// that (cref:AccessibilityChecker) treats a `private`/`protected`
        /// member of the enclosing type reached through a type-qualified receiver
        /// (`Type.Member`) or a constructor call (`Type()`) as accessible — matching
        /// how a `shared` function body already behaves.
        /// @param owner The type whose initializers are being bound.
        /// @returns A synthetic static function owned by [`owner`](paramref).
        private func CreateFieldInitializerAccessibilityContext(owner StructSymbol) FunctionSymbol {
            let context = FunctionSymbol("<field-initializer>", ImmutableArray[ParameterSymbol].Empty, TypeSymbol.Void){
                IsStatic = true,
                IsExpressionInitializer = true,
                StaticOwnerType = owner
            }
            return context
        }

        /// Issue #1070: binds and folds a deferred `const`-field initializer to a
        /// compile-time constant, reporting GS-not-constant if the expression is not a
        /// constant. Shared by the class-body and `shared`-block const paths.
        ///
        /// ADR-0122 §10 / issue #1035: returns the unmanaged byte size of a fixed-size
        /// buffer element type. Only the C#-compatible blittable primitives are
        /// permitted (bool, the integer types, char, and the floating-point types).
        /// @param elementType The buffer element type.
        /// @param size The element size in bytes when supported.
        /// @returns `true` when the element type is a supported fixed-buffer element.
        private func TryGetFixedBufferElementSize(elementType TypeSymbol, out size int32) bool {
            size = 0
            if elementType == TypeSymbol.Bool || elementType == TypeSymbol.Int8 || elementType == TypeSymbol.UInt8 {
                size = 1
            } else if elementType == TypeSymbol.Int16 ||
                elementType == TypeSymbol.UInt16 ||
                elementType == TypeSymbol.Char {
                size = 2
            } else if elementType == TypeSymbol.Int32 ||
                elementType == TypeSymbol.UInt32 ||
                elementType == TypeSymbol.Float32 {
                size = 4
            } else if elementType == TypeSymbol.Int64 ||
                elementType == TypeSymbol.UInt64 ||
                elementType == TypeSymbol.Float64 {
                size = 8
            }
            return size != 0
        }
    }
}
