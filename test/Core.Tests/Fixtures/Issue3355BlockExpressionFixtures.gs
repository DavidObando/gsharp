// <copyright file="Issue3355BlockExpressionFixtures.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.Fixtures

import System

/// CLR base-constructor overload fixture for issue #3355. First argument
/// selects overload before target-dependent block-lambda argument is rebound.
abstract class Issue3355OverloadedBaseFixture {
    protected init(value int32, transform(int32) -> int32) {
        Value = transform(value)
    }

    protected init(value string, transform(string) -> string) {
        Value = transform(value).Length
    }

    protected init(value int32, transform(int32, int32) -> int32) {
        Value = transform(value, 0)
    }

    prop Value int32 {
        get;
    }
}

/// Imported overload fixture for target-dependent block arguments.
shared class Issue3355OverloadedMethodFixture {
    func Apply(value int32, transform(int32) -> int32) int32 -> transform(value)

    func Apply(value int32, transform(int32, int32) -> int32) int32 -> transform(value, 0)

    func Apply(value int32, transform(string) -> string, extra int32) int32 -> transform(value.ToString()).Length +
        extra
}

/// Imported constructor overload fixture for target-dependent block arguments.
class Issue3355OverloadedObjectFixture {
    init(value int32, transform(int32) -> int32) {
        Value = transform(value)
    }

    init(value int32, transform(int32, int32) -> int32) {
        Value = transform(value, 0)
    }

    init(value int32, transform(string) -> string, extra int32) {
        Value = transform(value.ToString()).Length + extra
    }

    prop Value int32 {
        get;
    }
}
