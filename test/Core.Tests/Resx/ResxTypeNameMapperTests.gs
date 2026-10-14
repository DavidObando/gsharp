// <copyright file="ResxTypeNameMapperTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Resx

import GSharp.Core.Resx
import Xunit

open class ResxTypeNameMapperTests {
    @Theory
    @InlineData("System.Byte[], mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089", "[]uint8")
    @InlineData("System.String, mscorlib", "string")
    @InlineData("System.Int32, mscorlib", "int32")
    @InlineData("System.Drawing.Bitmap, System.Drawing", "System.Drawing.Bitmap")
    @InlineData("System.Int32[][], mscorlib", "[][]int32")
    func Map_ReturnsExpectedGSharpType(assemblyQualifiedTypeName string, expected string) {
        Assert.Equal(expected, ResxTypeNameMapper.Map(assemblyQualifiedTypeName))
    }
}
