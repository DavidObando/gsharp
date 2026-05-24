// file: EventSubscription.gs
// Stream B′ demo: subscribing to a CLR event with `+=` and unsubscribing
// with `-=`. Function literals automatically materialize as the event's
// declared delegate type when their signature matches.

package GSharp.Example.EventSubscription

import System

var domain = AppDomain.CurrentDomain

domain.ProcessExit += func(sender Object, e EventArgs) {
    Console.WriteLine("would only fire if not removed")
}

Console.WriteLine("subscribed")
