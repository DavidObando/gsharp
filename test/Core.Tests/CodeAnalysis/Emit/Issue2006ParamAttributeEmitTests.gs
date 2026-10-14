// <copyright file="Issue2006ParamAttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import System
import System.Collections.ObjectModel
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #2006 (round-3 rubber-duck re-review follow-up to #1913/#1993): two
/// more `TypeDefEmitter` emit paths mint Parameter rows but never call
/// `EmitUserAttributesOnParameters` — `AddPrimaryCtorParameterRows`
/// (used by both `EmitClassPrimaryConstructor` and
/// `EmitClassConstructorWithBaseInitializer`) and the delegate
/// `Invoke` parameter loop in `EmitDelegateTypeDef`. The binder
/// attaches the attribute to the `ParameterSymbol` correctly (proven by
/// AttributeUsage validation firing), but it silently never reaches the
/// emitted metadata. These tests read the compiled assembly's real Parameter
/// metadata via reflection ((cref:ParameterInfo.GetCustomAttributes(bool)))
/// — the same empirical technique used in `Issue1913ParamAttributeEmitTests`
/// — rather than just asserting the binder-level symbol.
open class Issue2006ParamAttributeEmitTests {
    @Fact
    func PrimaryCtorParameter_NoBaseInitializer_UserAttribute_RoundTripsThroughReflection() {
        const Source = `package Issue2006PrimCtor
import System
` + NoteAttributeDecl + `

class Box(@Note("prim") z int32) {
}
`
        let asm = CompileToAssembly(
            Source,
            "PrimaryCtorParameter_NoBaseInitializer_UserAttribute_RoundTripsThroughReflection"
        )
        let box = asm.GetTypes().Single((t Type) -> t.Name == "Box")
        let ctor = box.GetConstructors().Single((c ConstructorInfo) -> c.GetParameters().Length == 1)
        let param = ctor.GetParameters()[0]
        Assert.Equal("z", param.Name)
        let attrs = param.GetCustomAttributes(true)
        Assert.Single(attrs)
        Assert.Equal("NoteAttribute", attrs[0].GetType().Name)
        let textProp MemberInfo? = attrs[0].GetType().GetField("Text") ??
            cast[MemberInfo](attrs[0].GetType().GetProperty("Text"))
        let textValue object? = switch textProp {
            case f is FieldInfo: f.GetValue(attrs[0])
            case p is PropertyInfo: p.GetValue(attrs[0])
            default: default(object?)
        }
        Assert.Equal("prim", textValue)
    }

    @Fact
    func PrimaryCtorParameter_WithBaseInitializer_UserAttribute_RoundTripsThroughReflection() {
        const Source = `package Issue2006PrimCtorBase
import System
` + NoteAttributeDecl + `

open class Animal(Name string) {
}

class Dog(@Note("derived") Name string) : Animal(Name) {
}
`
        let asm = CompileToAssembly(
            Source,
            "PrimaryCtorParameter_WithBaseInitializer_UserAttribute_RoundTripsThroughReflection"
        )
        let dog = asm.GetTypes().Single((t Type) -> t.Name == "Dog")
        let ctor = dog.GetConstructors().Single((c ConstructorInfo) -> c.GetParameters().Length == 1)
        let param = ctor.GetParameters()[0]
        Assert.Equal("Name", param.Name)
        let attrs = param.GetCustomAttributes(true)
        Assert.Single(attrs)
        Assert.Equal("NoteAttribute", attrs[0].GetType().Name)
        let textProp MemberInfo? = attrs[0].GetType().GetField("Text") ??
            cast[MemberInfo](attrs[0].GetType().GetProperty("Text"))
        let textValue object? = switch textProp {
            case f is FieldInfo: f.GetValue(attrs[0])
            case p is PropertyInfo: p.GetValue(attrs[0])
            default: default(object?)
        }
        Assert.Equal("derived", textValue)
    }

    @Fact
    func DataStructPrimaryCtorParameters_NullabilityAndTupleNames_RoundTripThroughReflection() {
        const Source = `package Issue4675DataStructCtorMetadata
data struct Item(Maybe string?, Pair (Name string, Count int32)) {
}`
        let asm = CompileToAssembly(
            Source,
            "DataStructPrimaryCtorParameters_NullabilityAndTupleNames_RoundTripThroughReflection"
        )
        let item = asm.GetTypes().Single((t Type) -> t.Name == "Item")
        let parameters = Assert.Single(item.GetConstructors()).GetParameters()
        Assert.Equal([]string{"Maybe", "Pair"}, parameters.Select((parameter ParameterInfo) -> parameter.Name))
        let nullability = NullabilityInfoContext().Create(parameters[0])
        Assert.Equal(NullabilityState.Nullable, nullability.ReadState)
        let tupleNames = Assert.Single(
            parameters[1].GetCustomAttributesData(),
            (attribute CustomAttributeData) -> attribute
                .AttributeType
                .FullName == "System.Runtime.CompilerServices.TupleElementNamesAttribute"
        )
        let names = (
            cast[ReadOnlyCollection[CustomAttributeTypedArgument]](Assert.Single(tupleNames.ConstructorArguments).Value)
        )
            .Select((argument CustomAttributeTypedArgument) -> cast[string](argument.Value)).ToArray()
        Assert.Equal([]string{"Name", "Count"}, names)
    }

    @Fact
    func DelegateInvokeParameter_UserAttribute_RoundTripsThroughReflection() {
        // Named delegates are bound before user struct/class declarations in
        // the same compilation (ADR-0059 / issue #255 declaration ordering),
        // so a delegate-parameter attribute type must come from an already
        //-compiled reference assembly here rather than a same-file
        // `class NoteAttribute(...)`, which would not yet be resolvable when
        // the delegate's parameters are bound.
        const Source = `package Issue2006Delegate
import System
import GSharp.Core.Tests.Fixtures

delegate IntPredicate(@ImportedDefault a int32) bool;
`
        let asm = CompileToAssembly(Source, "DelegateInvokeParameter_UserAttribute_RoundTripsThroughReflection")
        let del = asm.GetTypes().Single((t Type) -> t.Name == "IntPredicate")
        let invoke MethodInfo? = del.GetMethod("Invoke", BindingFlags.Public | BindingFlags.Instance)
        Assert.NotNull(invoke)
        let param = invoke!!.GetParameters()[0]
        Assert.Equal("a", param.Name)
        let attrs = param.GetCustomAttributes(true)
        Assert.Single(attrs)
        Assert.Equal("ImportedDefaultAttribute", attrs[0].GetType().Name)
    }

    shared {
        private const NoteAttributeDecl string = `
class NoteAttribute(Text string) : Attribute {
}
`

        private func CompileToAssembly(source string, contextName string) Assembly {
            using let peStream = MemoryStream()
            let fixturePath = typeof(ImportedGreeter).Assembly.Location
            let tree = SyntaxTree.Parse(SourceText.From(source))
            let compilation = Compilation(ReferenceResolver.WithReferences([]string{fixturePath}), tree)
            let result = compilation.Emit(peStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            peStream.Position = 0
            let loadContext = AssemblyLoadContext(contextName, isCollectible: true)
            return loadContext.LoadFromStream(peStream)
        }
    }
}
