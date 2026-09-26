// <copyright file="DescendantsCorpus.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System;

namespace GSharp.Core.CodeAnalysis.Binding
{
    public class Consumer
    {
        // Three local references (the condition, the assignment TARGET, the
        // return) and one call.
        public int Assign()
        {
            int x = 0;
            if (x == 0)
            {
                x = Make();
            }

            return x;
        }

        // One call, inside the lambda's body.
        public Func<int> Lambda()
        {
            return () => Make();
        }

        // One local reference and no pattern: a plain type test.
        public bool PlainIs()
        {
            object o = "s";
            return o is string;
        }

        private static int Make() => 1;
    }
}
