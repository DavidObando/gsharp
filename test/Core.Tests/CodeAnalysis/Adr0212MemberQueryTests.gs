// <copyright file="Adr0212MemberQueryTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.Globalization
import System.Linq
import System.Text
import Xunit

/// ADR-0212 slice S4: (cref:SemanticModel.LookupMembers) and (cref:SemanticModel.GetMemberGroup).
/// One test per row of the contract tables in the documentation of the two queries. The marker
/// `// Pname` ends the line of the call or member access that the row queries.
open class Adr0212MemberQueryTests {
    // ---- GetMemberGroup, one test per row ----

    @Fact
    func MemberGroup_ImportedFunction_IsTheReflectionOverloadSetInMetadataOrder() {
        let group = Group("PConsole")
        Assert.True(group.Length > 5, "Console.WriteLine has many overloads: ${group.Length}")
        Assert.All(group, (s Symbol) -> Assert.IsType[ImportedFunctionSymbol](s))
        let tokens = group.Select((s Symbol) -> cast[ImportedFunctionSymbol](s).Method.MetadataToken).ToList()
        Assert.Equal(tokens.OrderBy((t int32) -> t).ToList(), tokens)
        Assert.All(group, (s Symbol) -> Assert.Equal("WriteLine", s.Name))
    }

    @Fact
    func MemberGroup_ImportedInstanceMethod_IsTheOverloadSetOfTheReceiverType() {
        let group = Group("PAppend")
        Assert.True(group.Length > 5, "StringBuilder.Append has many overloads: ${group.Length}")
        Assert.All(
            group,
            (s Symbol) -> Assert.Equal("StringBuilder", cast[ImportedFunctionSymbol](s).Method.DeclaringType!!.Name)
        )
    }

    @Fact
    func MemberGroup_LocalFunction_IsTheFunctionAlone() {
        let group = Group("PLocal")
        let only = Assert.Single(group)
        Assert.Equal("local", only.Name)
    }

    @Fact
    func MemberGroup_FreeFunction_IsOrderedByFilePathThenStart() {
        let group = Group("PFree")
        Assert.Equal(4, group.Length)
        let shapes = group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
        // a.gs declares the first two, in source order; b.gs the others.
        Assert.Equal([]string{"Free(int32)", "Free(string)", "Free(int32, int32)", "Free(bool)"}, shapes)
    }

    @Fact
    func MemberGroup_DeclaredMethods_AreTheMethodsOfTheReceiverType() {
        let group = Group("PCat")
        Assert.Equal(
            []string{"Purr(int32)", "Purr(string)"},
            group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToArray()
        )
    }

    @Fact
    func MemberGroup_InheritedCall_ListsTheDerivedMethodsBeforeTheBase() {
        let group = Group("PInherited")
        Assert.Equal(
            []string{"Speak(bool)", "Speak(int32)", "Speak(string)", "Speak()"},
            group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
        )
    }

    @Fact
    func MemberGroup_BaseCall_ListsTheBaseOverloadsAndSubstitutesConstructedBase() {
        let baseCall = CallAt("PBase")
        let baseModel = ModelOf(baseCall)
        let baseGroup = baseModel.GetMemberGroup(baseCall)
        Assert.Equal(
            []string{"Speak(int32)", "Speak(string)", "Speak()"},
            baseGroup.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
        )
        Assert.Equal(
            baseGroup.ToArray(),
            baseModel.GetMemberGroup(cast[BaseClassCallExpressionSyntax](baseCall.Parent!!)).ToArray()
        )
        let genericBaseCall = CallAt("PGenericBase")
        let genericBaseModel = ModelOf(genericBaseCall)
        let genericBaseGroup = genericBaseModel.GetMemberGroup(genericBaseCall)
        Assert.Equal(
            []string{"Echo(int32)", "Echo(int32, string)"},
            genericBaseGroup.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
        )
        Assert.Equal(
            genericBaseGroup.ToArray(),
            genericBaseModel.GetMemberGroup(cast[BaseClassCallExpressionSyntax](genericBaseCall.Parent!!)).ToArray()
        )
        let baseInterfaceNode = Trees[0].Root.DescendantNodes().OfType[BaseInterfaceCallExpressionSyntax]().Single()
        let baseInterfaceGroup = genericBaseModel.GetMemberGroup(baseInterfaceNode)
        Assert.Equal(
            []string{"Put(int32)", "Put(int32, int32)"},
            baseInterfaceGroup.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
        )
    }

    @Fact
    func MemberGroup_TypeParameterStaticConstraintCall_ListsTheStaticOverloads() {
        for call in[]CallExpressionSyntax{
            CallAt("PConstraintStatic"),
            cast[CallExpressionSyntax](
                cast[AccessorExpressionSyntax](CallAt("PConstraintStaticNested").Arguments[0]).RightPart
            )
        } {
            let group = ModelOf(call).GetMemberGroup(call)
            Assert.Equal(
                []string{"Parse(string)", "Parse(string, int32)"},
                group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
            )
            Assert.All(group, (s Symbol) -> Assert.Equal("T", cast[FunctionSymbol](s).Type.Name))
        }
        for call in[]CallExpressionSyntax{
            CallAt("PClrConstraintStatic"),
            cast[CallExpressionSyntax](
                cast[AccessorExpressionSyntax](CallAt("PClrConstraintStaticNested").Arguments[0]).RightPart
            )
        } {
            let group = ModelOf(call).GetMemberGroup(call)
            Assert.Equal(2, group.Length)
            Assert.All(group, (s Symbol) -> Assert.IsType[ImportedFunctionSymbol](s))
            Assert.All(group, (s Symbol) -> Assert.Equal("U", cast[ImportedFunctionSymbol](s).Type.Name))
            let tokens = group.Select((s Symbol) -> cast[ImportedFunctionSymbol](s).Method.MetadataToken).ToList()
            Assert.Equal(tokens.OrderBy((t int32) -> t).ToList(), tokens)
        }
    }

    @Fact
    func MemberGroup_UnfinishedCall_ListsTheCandidatesCollectedBeforeFailure() {
        let unfinishedSource = `package Members
import GSharp.Core.Tests.CodeAnalysis
import System
import System.Text

func UseUnfinished[T IImportedParsable[T]](sb StringBuilder, c Cat) {
    sb.Append( // PUnfinishedImported
    Free( // PUnfinishedFree
    c.Purr( // PUnfinishedInstance
    T.Parse( // PUnfinishedConstraint
}

class UnfinishedDog : Animal {
    func Act() {
        base.Speak( // PUnfinishedBase
    }
}
`
        let unfinishedTree = SyntaxTree.Parse(SourceText.From(unfinishedSource, "unfinished.gs"))
        let compilation = Compilation(Trees[1], Trees[0], unfinishedTree)
        compilation.RecordMemberGroups = true
        let model = compilation.GetSemanticModel(unfinishedTree)
        let FindCall = (marker string) -> {
            let at = unfinishedSource.IndexOf("// " + marker, StringComparison.Ordinal)
            let lineStart = unfinishedSource.LastIndexOf('\n', at - 1) + 1
            return unfinishedTree
                .Root
                .DescendantNodes()
                .OfType[CallExpressionSyntax]()
                .Last((call CallExpressionSyntax) -> call.Span.Start >= lineStart && call.Span.Start <= at)
        }
        let appendGroup = model.GetMemberGroup(FindCall("PUnfinishedImported"))
        Assert.True(appendGroup.Length > 5, "StringBuilder.Append has many overloads: ${appendGroup.Length}")
        Assert.All(
            appendGroup,
            (s Symbol) -> Assert.Equal("StringBuilder", cast[ImportedFunctionSymbol](s).Method.DeclaringType!!.Name)
        )
        let freeGroup = model.GetMemberGroup(FindCall("PUnfinishedFree"))
        Assert.Equal(
            []string{"Free(int32)", "Free(string)", "Free(int32, int32)", "Free(bool)"},
            freeGroup.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
        )
        let instanceGroup = model.GetMemberGroup(FindCall("PUnfinishedInstance"))
        Assert.Equal(
            []string{"Purr(int32)", "Purr(string)"},
            instanceGroup.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
        )
        let baseGroup = model.GetMemberGroup(FindCall("PUnfinishedBase"))
        Assert.Equal(
            []string{"Speak(int32)", "Speak(string)", "Speak()"},
            baseGroup.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
        )
        let constraintGroup = model.GetMemberGroup(FindCall("PUnfinishedConstraint"))
        Assert.Equal(2, constraintGroup.Length)
        Assert.All(constraintGroup, (s Symbol) -> Assert.IsType[ImportedFunctionSymbol](s))
    }

    @Fact
    func MemberGroup_InterfaceCall_ListsTheInterfaceMethodsNotItsPrivateHelpers() {
        let group = Group("PInterface")
        Assert.Equal(
            []string{"Read(int32)", "Read(string)"},
            group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToArray()
        )
    }

    @Fact
    func MemberGroup_ConstructedGenericInterface_ListsTheMethodsAtTheConstructedType() {
        let group = Group("PBoxed")
        Assert.Equal(
            []string{"Put(int32)", "Put(int32, int32)"},
            group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
        )
        let dual = Group("PDualBoxed")
        Assert.Equal(
            []string{"Put(int32)", "Put(string)", "Put(int32, int32)", "Put(string, int32)"},
            dual.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToList()
        )
        let dualAccess = cast[AccessorExpressionSyntax](CallAt("PDualConstraint").Parent!!)
        let dualModel = ModelOf(dualAccess)
        let dualTypeParam = dualModel.GetReceiverTypeInfo(dualAccess.LeftPart).Type!!
        let dualMembers = dualModel.LookupMembers(Position("PDualConstraint"), dualTypeParam, "Put")
        Assert.Equal(
            []string{"Put(int32)", "Put(int32, int32)", "Put(string)", "Put(string, int32)"},
            dualMembers.OfType[FunctionSymbol]().Select(Describe).ToList()
        )
    }

    @Fact
    func MemberGroup_TypeParameterWithConstraint_ListsTheMethodsOfTheConstraint() {
        let group = Group("PConstraint")
        Assert.Equal(
            []string{"Read(int32)", "Read(string)"},
            group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToArray()
        )
    }

    @Fact
    func MemberGroup_PartialType_ListsThePartsByFilePath() {
        let group = Group("PPartial")
        Assert.Equal(
            []string{"Go(int32)", "Go(string)", "Go(bool)"},
            group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToArray()
        )
    }

    @Fact
    func MemberGroup_QualifiedStaticCall_ListsTheSharedOverloads() {
        let group = Group("PStatic")
        Assert.Equal(
            []string{"Make(int32, int32)", "Make(int32)", "Make(string)", "Make(int32, bool)"},
            group.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToArray()
        )
    }

    @Fact
    func MemberGroup_SourceExtension_IsTheExtensionsForTheReceiverInFileThenStartOrder() {
        let overloaded = Group("PSourceExt")
        Assert.Equal(
            []string{"Scale(int32, int32)", "Scale(int32, string)", "Scale(int32, int32, int32)"},
            overloaded.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToArray()
        )
        let single = Group("PSourceExtSingle")
        Assert.Equal([]string{"Abs(int32)"}, single.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToArray())
        let genericSingle = Group("PSourceExtGenericSingle")
        Assert.Equal(
            []string{"Repeat(int32, T)"},
            genericSingle.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToArray()
        )
        let genericOverloaded = Group("PSourceExtGeneric")
        Assert.Equal(
            []string{
                "Pick(System.Collections.Generic.IList`1[T], int32)",
                "Pick(System.Collections.Generic.IList`1[T], int32, T)"
            },
            genericOverloaded.Select((s Symbol) -> Describe(cast[FunctionSymbol](s))).ToArray()
        )
    }

    @Fact
    func MemberGroup_ImportedExtension_IsTheMethodsForTheReceiverInHolderThenMetadataOrder() {
        let selectCall = CallAt("PImportedExt")
        let selectAccess = cast[AccessorExpressionSyntax](selectCall.Parent!!)
        let selectModel = ModelOf(selectCall)
        Assert.Equal(SliceTypeSymbol.Get(TypeSymbol.Int32), selectModel.GetReceiverTypeInfo(selectAccess.LeftPart).Type)
        let selectGroup = selectModel.GetMemberGroup(selectCall)
        Assert.Equal(2, selectGroup.Length)
        Assert.All(selectGroup, (s Symbol) -> Assert.IsType[ImportedFunctionSymbol](s))
        Assert.All(
            selectGroup,
            (s Symbol) -> {
                let imported = cast[ImportedFunctionSymbol](s)
                Assert.Equal("Enumerable", imported.Method.DeclaringType!!.Name)
                Assert.True(imported.Method.IsGenericMethodDefinition)
            }
        )
        let selectTokens = selectGroup.Select((s Symbol) -> cast[ImportedFunctionSymbol](s).Method.MetadataToken)
            .ToList()
        Assert.Equal(selectTokens.OrderBy((t int32) -> t).ToList(), selectTokens)
        let toListCall = CallAt("PImportedExtSingle")
        let toListModel = ModelOf(toListCall)
        let toListSingle = Assert.IsType[ImportedFunctionSymbol](Assert.Single(toListModel.GetMemberGroup(toListCall)))
        Assert.Equal("Enumerable", toListSingle.Method.DeclaringType!!.Name)
        Assert.True(toListSingle.Method.IsGenericMethodDefinition)
        let toListLookup = Assert.Single(
            toListModel.LookupMembers(Position("PImportedExtSingle"), SliceTypeSymbol.Get(TypeSymbol.Int32), "ToList")
        )
        Assert.Same(toListLookup, toListSingle)
        let asSpanGroup = Group("PImportedExtNonGeneric")
        Assert.NotEmpty(asSpanGroup)
        Assert.All(
            asSpanGroup,
            (s Symbol) -> {
                let imported = cast[ImportedFunctionSymbol](s)
                Assert.Equal("MemoryExtensions", imported.Method.DeclaringType!!.Name)
                Assert.False(imported.Method.IsGenericMethod)
                Assert.Equal(typeof(string), imported.Method.GetParameters()[0].ParameterType)
            }
        )
        let comparerCall = CallAt("PImportedExtNonGenericSingle")
        let comparerModel = ModelOf(comparerCall)
        let comparerSingle = Assert.IsType[ImportedFunctionSymbol](
            Assert.Single(comparerModel.GetMemberGroup(comparerCall))
        )
        Assert.Equal("GlobalizationExtensions", comparerSingle.Method.DeclaringType!!.Name)
        Assert.False(comparerSingle.Method.IsGenericMethod)
        let comparerLookup = Assert.Single(
            comparerModel.LookupMembers(
                Position("PImportedExtNonGenericSingle"),
                ImportedTypeSymbol.Get(typeof(CompareInfo)),
                "GetStringComparer"
            )
        )
        Assert.Same(comparerLookup, comparerSingle)
        let reprojectInferred = selectModel.GetMemberGroup(CallAt("PReprojectInferred"))
        let reprojectExplicit = selectModel.GetMemberGroup(CallAt("PReprojectExplicit"))
        let reprojectLookup = selectModel.LookupMembers(
            Position("PReprojectInferred"),
            SliceTypeSymbol.Get(TypeSymbol.Int32),
            "Reproject"
        )
        Assert.Equal(
            []int32{1, 2},
            reprojectInferred.Select((s Symbol) -> cast[ImportedFunctionSymbol](s).Method.GetParameters().Length)
                .ToArray()
        )
        Assert.All(
            reprojectExplicit,
            (s Symbol) -> Assert.True(cast[ImportedFunctionSymbol](s).Method.IsGenericMethodDefinition)
        )
        Assert.Equal(reprojectInferred.ToList(), reprojectExplicit.ToList())
        Assert.Equal(reprojectInferred.ToList(), reprojectLookup.ToList())
    }

    @Fact
    func MemberGroup_LocalAndTypeNames_AreEmpty() {
        for text in[]string{"c", "Util"} {
            let name = Names(Trees[0].Root).First((n NameExpressionSyntax) -> n.IdentifierToken.Text == text)
            Assert.True(ModelOf(name).GetMemberGroup(name).IsEmpty, text)
        }
    }

    @Fact
    func LookupMembers_PrivateMemberOfAConstructedBase_IsNotOfferedInTheDerivedType() {
        let names = Members("PInGDerived", "GDerived").Select((s Symbol) -> s.Name).ToList()
        Assert.Contains("Shown", names)
        Assert.DoesNotContain("Hidden", names)
    }

    @Fact
    func LookupMembers_ImportedOverride_IsAnOverride() {
        let model = ModelOf(Trees[0].Root)
        let length = Assert.Single(
            model.LookupMembers(Position("PLookup"), ImportedTypeSymbol.Get(typeof(System.IO.FileStream)), "Length")
        )
        Assert.True(cast[PropertySymbol](length).IsOverride)
    }

    @Fact
    func MemberGroup_WithoutRecording_AnswersNothing() {
        let tree = Trees[0]
        let plain = Compilation(Trees[1], Trees[0])
        Assert.False(plain.RecordMemberGroups)
        let call = CallAt("PFree")
        Assert.True(plain.GetSemanticModel(tree).GetMemberGroup(call).IsEmpty)
        Assert.False(ModelOf(call).GetMemberGroup(call).IsEmpty)
    }

    @Fact
    func MemberGroup_TopLevelCall_IsRecordedWhenTheGlobalScopeIsQueriedFirst() {
        let tree = SyntaxTree.Parse(SourceText.From("import System\nConsole.WriteLine(\"x\")\n", "top.gs"))
        let compilation = Compilation(tree)
        compilation.RecordMemberGroups = true
        Assert.NotNull(compilation.GlobalScope)
        let call = Calls(tree.Root).Single()
        Assert.True(compilation.GetSemanticModel(tree).GetMemberGroup(call).Length > 5)
    }

    @Fact
    func RecordMemberGroups_CannotChangeAfterTheCompilationBinds() {
        let tree = SyntaxTree.Parse(SourceText.From("func F() int32 { return 1 }\n", "bound.gs"))
        let compilation = Compilation(tree)
        compilation.RecordMemberGroups = true
        Assert.NotNull(compilation.GlobalScope)
        compilation.RecordMemberGroups = true
        Assert.Throws[InvalidOperationException](() -> compilation.RecordMemberGroups = false)
    }

    @Fact
    func MemberGroup_ArgumentProbe_DoesNotReplaceTheCalleesGroup() {
        // The method-group argument is resolved against the Console overloads inside the call.
        let group = Group("PProbe")
        Assert.Equal(2, group.Length)
        Assert.All(group, (s Symbol) -> Assert.IsType[FunctionSymbol](s))
    }

    @Fact
    func LookupMembers_ImportedLiteralField_CarriesItsConstant() {
        let model = ModelOf(Trees[0].Root)
        let max = Assert.Single(
            model.LookupMembers(Position("PLookup"), ImportedTypeSymbol.Get(typeof(int32)), "MaxValue")
        )
        Assert.Equal(int32.MaxValue, cast[FieldSymbol](max).ConstantValue)
    }

    @Fact
    func LookupMembers_ImportedConcreteVirtualProperty_IsNotAbstract() {
        let model = ModelOf(Trees[0].Root)
        let message = Assert.Single(
            model.LookupMembers(Position("PLookup"), ImportedTypeSymbol.Get(typeof(Exception)), "Message")
        )
        Assert.False(cast[PropertySymbol](message).IsAbstract)
    }

    @Fact
    func MemberGroup_FieldRead_IsTheMemberAlone() {
        let name = Names(Trees[0].Root).Last(
            (n NameExpressionSyntax) -> n.IdentifierToken.Text == "Legs" && n.Span.End <= Position("PProperty")
        )
        let only = Assert.Single(ModelOf(name).GetMemberGroup(name))
        Assert.IsType[FieldSymbol](only)
        Assert.Equal("Legs", only.Name)
    }

    @Fact
    func MemberGroup_NodeThatNamesNothing_IsEmpty() {
        let tree = Trees[0]
        let model = Compiled.GetSemanticModel(tree)
        Assert.True(model.GetMemberGroup(tree.Root).IsEmpty)
    }

    @Fact
    func MemberGroup_CallExpressionAndItsIdentifier_AnswerTheSameGroup() {
        let call = CallAt("PFree")
        let model = ModelOf(call)
        Assert.Equal(model.GetMemberGroup(call).ToArray(), model.GetMemberGroup(call.Identifier).ToArray())
    }

    @Fact
    func MemberGroup_IsDeterministic_WhateverTheOrderOfTheTrees() {
        let forward = Compilation(Trees[0], Trees[1])
        let backward = Compilation(Trees[1], Trees[0])
        forward.RecordMemberGroups = true
        backward.RecordMemberGroups = true
        let call = CallAt("PFree")
        let names = (model SemanticModel, c CallExpressionSyntax) -> model
            .GetMemberGroup(c)
            .Select((s Symbol) -> Describe(cast[FunctionSymbol](s)))
            .ToList()
        let first = names(forward.GetSemanticModel(Trees[0]), call)
        let second = names(backward.GetSemanticModel(Trees[0]), call)
        Assert.Equal(first, second)
    }

    // ---- LookupMembers, one test per row ----

    @Fact
    func LookupMembers_Struct_ListsInstanceMembersWithBasesLastThenOwnStatics() {
        let members = Members("PLookup", "Dog")
        let own = members.Where((s Symbol) -> s is not ImportedFunctionSymbol).Select((s Symbol) -> s.Name).ToList()
        // The type's own members, then its base class's, then the static members of the type itself.
        Assert.Equal([]string{"Tag", "Speak", "Use", "Legs", "Speak", "Speak", "Speak", "Inside", "Make"}, own)
        // `Dog` has no imported base: what follows are the members of `object` (issue #5441).
        Assert.Contains(members.Skip(own.Count), (s Symbol) -> s.Name == "ToString")
        Assert.All(
            members.Skip(own.Count),
            (s Symbol) -> Assert.Equal("Object", cast[ImportedFunctionSymbol](s).Method.DeclaringType!!.Name)
        )
    }

    @Fact
    func LookupMembers_Struct_DoesNotOfferAStaticOfABaseClass() {
        Assert.DoesNotContain("BaseStatic", Members("PLookup", "Dog").Select((s Symbol) -> s.Name))
        Assert.Contains("BaseStatic", Members("PLookup", "Animal").Select((s Symbol) -> s.Name))
    }

    @Fact
    func LookupMembers_PrivateMember_IsOfferedOnlyInsideItsType() {
        Assert.DoesNotContain("Secret", Members("PLookup", "Animal").Select((s Symbol) -> s.Name))
        Assert.Contains("Secret", Members("PInsideAnimal", "Animal").Select((s Symbol) -> s.Name))
    }

    @Fact
    func LookupMembers_WithName_ReturnsEveryOverload() {
        let model = ModelOf(Trees[0].Root)
        let position = Position("PLookup")
        let speak = model.LookupMembers(position, TypeNamed("Dog"), "Speak")
        Assert.Equal(4, speak.Length)
        Assert.True(model.LookupMembers(position, TypeNamed("Dog"), "NoSuchMember").IsEmpty)
    }

    @Fact
    func LookupMembers_Interface_ListsInterfaceAndBaseInterfaceMembers() {
        let names = Members("PLookup", "ISub").Select((s Symbol) -> s.Name).ToList()
        Assert.Equal([]string{"Sub", "Read", "Read"}, names.Take(3).ToArray())
    }

    @Fact
    func LookupMembers_Interface_ListsPrivateHelpersOnlyInsideTheInterface() {
        let outsideNames = Members("PLookup", "IRead").Select((s Symbol) -> s.Name).ToList()
        Assert.DoesNotContain("ReadHelper", outsideNames)
        Assert.DoesNotContain("StaticReadHelper", outsideNames)
        let subNames = Members("PInsideISub", "ISub").Select((s Symbol) -> s.Name).ToList()
        Assert.DoesNotContain("ReadHelper", subNames)
        Assert.DoesNotContain("StaticReadHelper", subNames)
        let insideNames = Members("PInsideIRead", "IRead").Select((s Symbol) -> s.Name).ToList()
        Assert.Contains("ReadHelper", insideNames)
        Assert.Contains("StaticReadHelper", insideNames)
        let boxedCall = CallAt("PBoxed")
        let model = ModelOf(boxedCall)
        let boxedAccess = cast[AccessorExpressionSyntax](boxedCall.Parent!!)
        let boxedType = model.GetReceiverTypeInfo(boxedAccess.LeftPart).Type!!
        Assert.Empty(model.LookupMembers(Position("PLookup"), boxedType, "SecretPut"))
        let secretPut = Assert.Single(model.LookupMembers(Position("PInsideIBoxed"), boxedType, "SecretPut"))
        Assert.Equal("SecretPut(int32)", Describe(cast[FunctionSymbol](secretPut)))
    }

    @Fact
    func LookupMembers_TypeParameterWithConstraint_ListsConstraintMembersThenObjectMembers() {
        let access = cast[AccessorExpressionSyntax](CallAt("PConstraint").Parent!!)
        let model = ModelOf(access)
        let typeParam = model.GetReceiverTypeInfo(access.LeftPart).Type!!
        let members = model.LookupMembers(Position("PConstraint"), typeParam)
        let own = members.OfType[FunctionSymbol]().Select(Describe).ToArray()
        Assert.Equal([]string{"Read(int32)", "Read(string)"}, own)
        Assert.Contains(members.Skip(own.Length), (s Symbol) -> s.Name == "ToString")
        Assert.All(
            members.Skip(own.Length),
            (s Symbol) -> Assert.Equal("Object", cast[ImportedFunctionSymbol](s).Method.DeclaringType!!.Name)
        )
    }

    @Fact
    func LookupMembers_Enum_ListsTheEnumMembers() {
        let names = Members("PLookup", "Color").Select((s Symbol) -> s.Name).ToList()
        Assert.Equal([]string{"Red", "Green"}, names)
    }

    @Fact
    func LookupMembers_Tuple_ListsDeclaredNamesThenPositionalNames() {
        let model = ModelOf(Trees[0].Root)
        let pair = TupleTypeSymbol.Get(
            ImmutableArray.Create[TypeSymbol](TypeSymbol.Int32, TypeSymbol.String),
            ImmutableArray.Create[string?]("left", "right")
        )
        // `System.TupleExtensions.ToTuple` follows as an imported extension (ADR-0212 question 12).
        let members = model.LookupMembers(Position("PLookup"), pair)
        Assert.Equal(
            []string{"left", "Item1", "right", "Item2"},
            members.OfType[FieldSymbol]().Select((s Symbol) -> s.Name).ToList()
        )
        Assert.DoesNotContain(members.Take(4), (s Symbol) -> s is ImportedFunctionSymbol)
    }

    @Fact
    func LookupMembers_NullableReceiver_AnswersForTheUnderlyingType() {
        let model = ModelOf(Trees[0].Root)
        let nullable = NullableTypeSymbol.Get(TypeNamed("Dog"))
        let plain = model.LookupMembers(Position("PLookup"), TypeNamed("Dog"))
        Assert.Equal(plain.ToArray(), model.LookupMembers(Position("PLookup"), nullable).ToArray())
        Assert.NotEmpty(plain)
    }

    @Fact
    func LookupMembers_ImportedType_ListsPublicInstanceAndStaticMembers() {
        let model = ModelOf(Trees[0].Root)
        let console = model.LookupMembers(Position("PLookup"), ImportedTypeSymbol.Get(typeof(Console)), "WriteLine")
        Assert.True(console.Length > 5)
        Assert.All(console, (s Symbol) -> Assert.IsType[ImportedFunctionSymbol](s))
        let builder = model.LookupMembers(Position("PLookup"), ImportedTypeSymbol.Get(typeof(StringBuilder)))
        Assert.Contains(builder, (s Symbol) -> s is PropertySymbol && s.Name == "Length")
        Assert.Contains(builder, (s Symbol) -> s is ImportedFunctionSymbol && s.Name == "Append")
        Assert.DoesNotContain(builder, (s Symbol) -> s.Name == "get_Length")
        Assert.DoesNotContain(builder, (s Symbol) -> s.Name == "Item")
    }

    @Fact
    func LookupMembers_ImportedMember_CarriesItsReflectedMember() {
        let model = ModelOf(Trees[0].Root)
        let length = Assert.Single(
            model.LookupMembers(Position("PLookup"), ImportedTypeSymbol.Get(typeof(StringBuilder)), "Length")
        )
        Assert.Equal(typeof(StringBuilder).GetProperty("Length"), cast[PropertySymbol](length).ImportedMember)
    }

    @Fact
    func LookupMembers_ImportedMemberTypes_ComeFromTheNullabilityReaders() {
        // `Path.GetDirectoryName(string)` is annotated `string?`; `Environment.NewLine` is `string`.
        let model = ModelOf(Trees[0].Root)
        let position = Position("PLookup")
        let directory = Assert.Single(
            model
                .LookupMembers(position, ImportedTypeSymbol.Get(typeof(System.IO.Path)), "GetDirectoryName")
                .OfType[ImportedFunctionSymbol]()
                .Where((f ImportedFunctionSymbol) -> f.Method.GetParameters()[0].ParameterType == typeof(string))
        )
        Assert.IsType[NullableTypeSymbol](directory.Type)
        let newLine = Assert.Single(
            model.LookupMembers(position, ImportedTypeSymbol.Get(typeof(Environment)), "NewLine")
        )
        Assert.IsNotType[NullableTypeSymbol](cast[PropertySymbol](newLine).Type)
    }

    @Fact
    func LookupMembers_IsDeterministic() {
        let model = ModelOf(Trees[0].Root)
        let position = Position("PLookup")
        let first = model.LookupMembers(position, ImportedTypeSymbol.Get(typeof(StringBuilder)))
        let second = ModelOf(Trees[0].Root).LookupMembers(position, ImportedTypeSymbol.Get(typeof(StringBuilder)))
        Assert.Equal(
            first.Select((s Symbol) -> s.Name + ":" + s.Kind.ToString()).ToList(),
            second.Select((s Symbol) -> s.Name + ":" + s.Kind.ToString()).ToList()
        )
    }

    // ---- Support ----

    shared {
        private func Describe(function FunctionSymbol) string {
            return function.Name + "(" + string.Join(
                ", ",
                function.Parameters.Select((p ParameterSymbol) -> p.Type.Name)
            ) +
                ")"
        }

        private const FileA string = `package Members
import GSharp.Core.Tests.CodeAnalysis
import System
import System.Collections.Generic
import System.Globalization
import System.Linq
import System.Text

func Free(x int32) int32 { return x }
func Free(s string) string { return s }

@ExtensionOwner(typeof(Animal))
func (value int32) Scale(factor int32) int32 { return value * factor }

@ExtensionOwner(typeof(Animal))
func (value int32) Scale(factor string) int32 { return value }

func (text string) Scale(factor int32) string { return text }

func (value int32) Abs() int32 { return value }

func (value int32) Repeat[T](item T) sequence[T?] {
    yield item
}

@ExtensionOwner(typeof(Animal))
func (items IList[T]) Pick[T](index int32) T { return items[index] }

@ExtensionOwner(typeof(Util))
func (value int32) Make(extra int32) int32 { return value + extra }

enum Color { Red, Green }

interface IRead {
    func Read(a int32) int32
    func Read(a string) int32 {
        return ReadHelper(a.Length) // PInsideIRead
    }
    private func ReadHelper(a int32) int32 { return a }
    shared {
        private func StaticReadHelper() int32 { return 1 }
    }
}

interface ISub : IRead {
    func Sub() int32 {
        return 0 // PInsideISub
    }
}

interface IBoxed[T] {
    func Put(v T) int32 {
        return SecretPut(v) // PInsideIBoxed
    }
    func Put(v T, n int32) int32 { return n }
    private func SecretPut(v T) int32 { return 0 }
}

interface IDualBoxed : IBoxed[int32], IBoxed[string] {
}

sealed interface IParse[TSelf] {
    shared {
        func Parse(s string) TSelf;
        func Parse(s string, radix int32) TSelf;
    }
}

open class Animal {
    var Legs int32
    private var Secret int32
    func Speak(a int32) string { return "" }
    func Speak(a string) string { return a }
    func Speak() string { return "" }
    func Inside() int32 {
        return Secret // PInsideAnimal
    }
    shared {
        var BaseStatic int32 = 1
    }
}

class Dog : Animal {
    var Tag string
    func Speak(a bool) string { return "" }
    func Use(d Dog) {
        d.Speak(1) // PInherited
        let s = base.Speak(1) // PBase
        let n = d.Legs // PProperty
    }
    shared {
        func Make() Dog {
            return Dog{}
        }
    }
}

open class GBase[T] {
    private var Hidden T
    var Shown T
    func Echo(a T) T { return a }
    func Echo(a T, label string) T { return a }
}

class GDerived : GBase[int32], IBoxed[int32] {
    func Echo(flag bool) int32 { return 0 }
    func Peek() int32 {
        let e = base.Echo(1) // PGenericBase
        let p = base[IBoxed[int32]].Put(1) // PBaseInterface
        return e + p // PInGDerived
    }
}

class Cat {
    func Purr(a int32) int32 { return a }
    func Purr(a string) int32 { return 0 }
}

func WriteLine(callback Action[object]) int32 { return 0 }
func WriteLine(a int32, b int32) int32 { return a }

class Util {
    shared {
        func Make(a int32) int32 { return a }
        func Make(a string) int32 { return 0 }
    }
}

partial class Parts {
    func Go(a int32) int32 { return a }
    func Go(a string) int32 { return 0 }
}

func Constrained[T IRead](t T) int32 {
    return t.Read(1) // PConstraint
}

func ConstrainedDual[T IDualBoxed](t T) int32 {
    return t.Put(1) // PDualConstraint
}

func TakeParsed[T](value T) T { return value }

func ConstrainedStatic[T IParse[T], U IImportedParsable[U]]() {
    let a = T.Parse("1") // PConstraintStatic
    let b = TakeParsed(T.Parse("1")) // PConstraintStaticNested
    let c = U.Parse("1") // PClrConstraintStatic
    let d = TakeParsed(U.Parse("1")) // PClrConstraintStaticNested
}

func UseAll(c Cat, r IRead, b IBoxed[int32], dual IDualBoxed, p Parts, sb StringBuilder, n int32, xs []int32, cmp CompareInfo) {
    Console.WriteLine("x") // PConsole
    sb.Append(1) // PAppend
    let local = func(q int32) int32 { return q }
    local(1) // PLocal
    Free(1) // PFree
    c.Purr(1) // PCat
    r.Read(1) // PInterface
    b.Put(1) // PBoxed
    dual.Put(1) // PDualBoxed
    p.Go(1) // PPartial
    Util.Make(1) // PStatic
    WriteLine(Console.WriteLine) // PProbe
    n.Abs() // PSourceExtSingle
    n.Scale(2) // PSourceExt
    n.Repeat("x") // PSourceExtGenericSingle
    xs.Pick(0) // PSourceExtGeneric
    ([]int32{1}).Select((x int32) -> x) // PImportedExt
    xs.ToList() // PImportedExtSingle
    "abc".AsSpan(1) // PImportedExtNonGeneric
    cmp.GetStringComparer(CompareOptions.None) // PImportedExtNonGenericSingle
    xs.Reproject((x int32) -> x.ToString()) // PReprojectInferred
    xs.Reproject[int32, string]() // PReprojectExplicit
    // PLookup
}
`

        private const FileB string = `package Members
import System.Collections.Generic

func Free(x int32, y int32) int32 { return x + y }
func Free(flag bool) bool { return flag }

@ExtensionOwner(typeof(Cat))
func (value int32) Scale(factor int32, bonus int32) int32 { return (value * factor) + bonus }

@ExtensionOwner(typeof(Cat))
func (items IList[T]) Pick[T](index int32, fallback T) T { return fallback }

@ExtensionOwner(typeof(Util))
func (value int32) Make(extra bool) int32 { return value }

partial class Parts {
    func Go(a bool) int32 { return 0 }
}
`

        private let Trees[]SyntaxTree = []SyntaxTree{
            SyntaxTree.Parse(SourceText.From(FileA, "a.gs")),
            SyntaxTree.Parse(SourceText.From(FileB, "b.gs"))
        }

        // One compilation for every row, with the trees in reverse path order.
        private let Compiled Compilation = CreateCompilation()

        private func CreateCompilation() Compilation {
            let compilation = Compilation(Trees[1], Trees[0])
            compilation.RecordMemberGroups = true
            Assert.Empty(compilation.GlobalScope.Diagnostics)
            Assert.Empty(compilation.BoundProgram.Diagnostics)
            return compilation
        }

        private func ModelOf(node SyntaxNode) SemanticModel {
            return Compiled.GetSemanticModel(node.SyntaxTree)
        }

        private func Position(marker string) int32 {
            let at = FileA.IndexOf("// " + marker + "\n", StringComparison.Ordinal)
            Assert.True(at >= 0, "marker ${marker} is in the source")
            return at
        }

        private func CallAt(marker string) CallExpressionSyntax {
            let position = Position(marker)
            let lineStart = FileA.LastIndexOf('\n', position - 1) + 1
            var best CallExpressionSyntax? = nil
            for call in Calls(Trees[0].Root) {
                if call
                    .Span
                    .Start >= lineStart &&
                    call
                    .Span
                    .End <= position &&
                    (best == nil || call.Span.End >= best.Span.End) {
                    best = call
                }
            }
            return Invariant.Required(best, "a call before the marker", expression: "best")
        }

        private func Names(node SyntaxNode) sequence[NameExpressionSyntax] {
            if node is NameExpressionSyntax name {
                yield name
            }
            for child in node.GetChildren() {
                for nested in Names(child) {
                    yield nested
                }
            }
        }

        private func Calls(node SyntaxNode) sequence[CallExpressionSyntax] {
            if node is CallExpressionSyntax call {
                yield call
            }
            for child in node.GetChildren() {
                for nested in Calls(child) {
                    yield nested
                }
            }
        }

        private func Group(marker string) ImmutableArray[Symbol] {
            let call = CallAt(marker)
            return ModelOf(call).GetMemberGroup(call)
        }

        private func TypeNamed(name string, marker string = "PLookup") TypeSymbol {
            return Assert.IsAssignableFrom[TypeSymbol](
                ModelOf(Trees[0].Root).LookupSymbols(Position(marker), name).Single()
            )
        }

        private func Members(marker string, typeName string) ImmutableArray[Symbol] {
            return ModelOf(Trees[0].Root).LookupMembers(Position(marker), TypeNamed(typeName, marker))
        }
    }
}

class ImportedGenericExtensionFixture { }

sealed interface IImportedParsable[TSelf] {
    shared{
        func Parse(s string) TSelf;

        func Parse(s string, radix int32) TSelf;
    }
}

@ExtensionOwner(typeof(ImportedGenericExtensionFixture))
func (items IEnumerable[T]) Reproject[T, U]() IEnumerable[U] {
    return Enumerable.Empty[U]()
}

@ExtensionOwner(typeof(ImportedGenericExtensionFixture))
func (items IEnumerable[T]) Reproject[T, U](selector(T) -> U) IEnumerable[U] {
    return items.Select(selector)
}

@ExtensionOwner(typeof(ImportedGenericExtensionFixture))
func (items ISet[T]) Reproject[T]() IEnumerable[T] {
    return items
}
