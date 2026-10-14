// <copyright file="Issue4589ExplicitPropertyAccessorEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Tests
import System
import System.Collections.Generic
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #4589: gsc emitted computed-body property accessors (including
/// explicit-interface ones) without (cref:MethodAttributes.SpecialName).
/// C# marks every property accessor SpecialName, and so did gsc's own
/// metadata-only (reference assembly) path, so reflection consumers such as
/// (cref:RefCapabilities.IsPropertyAccessor) did not recognize the
/// accessor of a G#-compiled explicit-interface property. These tests read the
/// emitted MethodDef flags through reflection.
open class Issue4589ExplicitPropertyAccessorEmitTests {
    @Theory
    @InlineData("Probe", "Issue4589.IProbe.Value")
    @InlineData("Probe", "Issue4589.IProbe.Other")
    @InlineData("Probe", "Computed")
    @InlineData("Probe", "Both")
    @InlineData("Probe", "Virtual")
    @InlineData("Probe", "StaticComputed")
    @InlineData("Probe", "Auto")
    @InlineData("Probe", "Item")
    @InlineData("ValueProbe", "Computed")
    func PropertyAccessors_AreSpecialName(typeName string, propertyName string) {
        let type = CompileToAssembly().GetTypes().Single((t Type) -> t.Name == typeName)
        let property = type.GetProperties(
            BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static | BindingFlags.DeclaredOnly
        )
            .Single((p PropertyInfo) -> p.Name == propertyName)
        // Issue #4628: collect only the accessors that exist. A get-only
        // property has no SetMethod; storing that null in an array and
        // filtering it afterwards migrates to a fail-fast `!!` on the element.
        let accessors = List[MethodInfo]()
        if property.GetMethod is {} getter {
            accessors.Add(getter)
        }
        if property.SetMethod is {} setter {
            accessors.Add(setter)
        }
        Assert.NotEmpty(accessors)
        for accessor in accessors {
            Assert.True(
                accessor.IsSpecialName,
                "${accessor.Name} should be SpecialName (attributes: ${accessor.Attributes})"
            )
            Assert.True(RefCapabilities.IsPropertyAccessor(accessor), accessor.Name)
        }
    }

    @Fact
    func OrdinaryMethod_IsNotSpecialName() {
        const MethodSource = `package Issue4589Method

class Holder {
    func get_Value() int32 {
        return 0
    }
}
`
        let type = CompileToAssembly(MethodSource).GetTypes().Single((t Type) -> t.Name == "Holder")
        let method MethodInfo? = type.GetMethod(
            "get_Value",
            BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly
        )
        Assert.NotNull(method)
        Assert.False(method!!.IsSpecialName)
        Assert.False(RefCapabilities.IsPropertyAccessor(method!!))
    }

    shared {
        private const Source string = `package Issue4589

interface IProbe {
    prop Value int32 { get }
    prop Other int32 { get set }
}

open class Probe : IProbe {
    private prop(IProbe) Value int32 -> 0
    private prop(IProbe) Other int32 { get { return 1 } set { } }
    prop Computed int32 -> 2
    prop Both int32 { get { return 3 } set { } }
    open prop Virtual int32 -> 4
    shared {
        prop StaticComputed int32 { get { return 5 } set { } }
    }
    prop Auto int32
    prop this[index int32] int32 -> index
}

struct ValueProbe {
    prop Computed int32 -> 6
}
`

        private func CompileToAssembly(source string = `package Issue4589

interface IProbe {
    prop Value int32 { get }
    prop Other int32 { get set }
}

open class Probe : IProbe {
    private prop(IProbe) Value int32 -> 0
    private prop(IProbe) Other int32 { get { return 1 } set { } }
    prop Computed int32 -> 2
    prop Both int32 { get { return 3 } set { } }
    open prop Virtual int32 -> 4
    shared {
        prop StaticComputed int32 { get { return 5 } set { } }
    }
    prop Auto int32
    prop this[index int32] int32 -> index
}

struct ValueProbe {
    prop Computed int32 -> 6
}
`) Assembly {
            using let peStream = MemoryStream()
            let compilation = Compilation(SyntaxTree.Parse(SourceText.From(source)))
            let result = compilation.Emit(peStream)
            Assert.True(result.Success, string.Join("; ", result.Diagnostics.Select((d Diagnostic) -> d.Message)))
            return EmittedFixture.Load(peStream.ToArray())
        }
    }
}
