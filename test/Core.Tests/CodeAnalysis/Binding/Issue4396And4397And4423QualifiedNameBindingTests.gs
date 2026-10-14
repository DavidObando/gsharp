// <copyright file="Issue4396And4397And4423QualifiedNameBindingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import GSharp.Core.CodeAnalysis
import GSharp.Tests
import System
import System.Reflection
import Xunit

/// Issues #4396, #4397, and #4423: an explicit package qualification must
/// select that package's type even when imports make the terminal simple name
/// ambiguous. A genuinely unqualified name remains ambiguous.
open class Issue4396And4397And4423QualifiedNameBindingTests {
    @Fact
    func QualifiedParameterAttribute_BindsAcrossPackage() {
        let result = Evaluate(`package N1
import System

@Attribute
class Tag {
}`, `package N2

class Tag {
}`, `package App
import N2

class C {
    func M(@N1.Tag x int32) int32 { return x }
}

C().M(42)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
        AssertParameterAttribute(result, "N1.Tag")
    }

    @Fact
    func NestedQualifiedParameterAttribute_BindsAcrossPackage() {
        let result = Evaluate(`package Lib.N1
import System

@Attribute
class Tag {
}`, `package N2

class Tag {
}`, `package App
import N2

class C {
    func M(@Lib.N1.Tag x int32) int32 { return x }
}

C().M(42)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
        AssertParameterAttribute(result, "Lib.N1.Tag")
    }

    @Fact
    func NestedTypeQualification_WinsOverSameNamedPackageType() {
        let result = Evaluate(`package Holder
import System

@Attribute
class Tag {
}`, `package App
import System

class Holder {
    @Attribute
    class Tag {
    }
}

class C {
    func M(@Holder.Tag x int32) int32 { return x }
}

C().M(42)`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal(42, result.Value)
        AssertParameterAttribute(result, "App.Holder+Tag")
    }

    @Fact
    func QualifiedEnumTypeAndDefault_SelectQualifiedPackage() {
        let result = Evaluate(`package E1

enum Mode {
    A,
    B
}`, `package E2

enum Mode {
    A,
    B
}`, `package App
import E1
import E2

func Pick(m E1.Mode = E1.Mode.B) string { return m.ToString() }
Pick()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("B", result.Value)
    }

    @Fact
    func FullyQualifiedStaticAccess_SelectsQualifiedPackage() {
        let result = Evaluate(`package A.X

class Thing {
    shared {
        func Name() string { return "x" }
    }
}`, `package A.Y

class Thing {
    shared {
        func Name() string { return "y" }
    }
}`, `package App
import A.X
import A.Y

A.Y.Thing.Name()`)
        Assert.Empty(result.Diagnostics)
        Assert.Equal("y", result.Value)
    }

    @Fact
    func UnqualifiedCollidingType_RemainsAmbiguous() {
        let result = Evaluate(`package A.X

class Thing {
}`, `package A.Y

class Thing {
}`, `package App
import A.X
import A.Y

let value Thing = Thing()`)
        Assert.Contains(result.Diagnostics, (diagnostic Diagnostic) -> diagnostic.Id == "GS0496")
    }

    shared {
        private func Evaluate(sources ...string) EmittedOracleResult -> EmittedOracle.Evaluate(sources)

        private func AssertParameterAttribute(result EmittedOracleResult, expectedTypeName string) {
            let type = Assert.Single(result.Assembly!!.GetTypes(), (candidate Type) -> candidate.Name == "C")
            let method = Assert.Single(type.GetMethods(), (candidate MethodInfo) -> candidate.Name == "M")
            let parameter = Assert.Single(method.GetParameters())
            let attribute = Assert.Single(parameter.GetCustomAttributesData())
            Assert.Equal(expectedTypeName, attribute.AttributeType.FullName)
        }
    }
}
