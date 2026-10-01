package com.henokabraham.ct45tracker

import org.junit.Assert.*
import org.junit.Test
import com.henokabraham.ct45tracker.DeliveryFeedbackState.Scan
import com.henokabraham.ct45tracker.DeliveryFeedbackState.Signal

class DeliveryFeedbackStateTest {
    @Test fun `receipt feedback needs a new captured scan and never repeats on another ack`() {
        val state = DeliveryFeedbackState()
        val received = Scan("new", saved = true, sent = true)
        assertNull(state.poll(listOf(received), 0)) // Restored history is quiet.
        state.capture("new", 10)
        assertNull(state.poll(listOf(received.copy(sent = false)), 100))
        assertEquals(Signal.RECEIVED, state.poll(listOf(received), 200))
        assertNull(state.poll(listOf(received), 2000))
    }

    @Test fun `waiting feedback requires durable storage and allows later receipt feedback`() {
        val state = DeliveryFeedbackState()
        state.capture("one", 0)
        val scan = Scan("one", saved = false, sent = false)
        assertNull(state.poll(listOf(scan), 2000))
        assertEquals(Signal.WAITING, state.poll(listOf(scan.copy(saved = true)), 2100))
        assertNull(state.poll(listOf(scan.copy(saved = true)), 4000))
        assertEquals(Signal.RECEIVED, state.poll(listOf(scan.copy(saved = true, sent = true)), 5000))
    }

    @Test fun `discard rejection disabled feedback and old backlogs stay quiet`() {
        for (stopped in listOf(true, false)) {
            val state = DeliveryFeedbackState()
            state.capture("one", 0)
            assertNull(state.poll(listOf(Scan("one", true, true, stopped)), if (stopped) 100 else 60001))
            assertFalse(state.pending)
        }
        val state = DeliveryFeedbackState()
        state.capture("one", 0)
        state.clear()
        assertNull(state.poll(listOf(Scan("one", true, true)), 1000))
    }

    @Test fun `bursts group receipts without losing a waiting outcome or playing it after delivery`() {
        val state = DeliveryFeedbackState()
        state.capture("a", 0); state.capture("b", 0)
        val a = Scan("a", true, true); val b = Scan("b", true, false)
        assertEquals(Signal.WAITING, state.poll(listOf(a, b), 1500))
        assertNull(state.poll(listOf(a, b.copy(sent = true)), 1600))
        assertEquals(Signal.RECEIVED, state.poll(listOf(a, b.copy(sent = true)), 2300))
        assertFalse(state.pending)
        state.capture("c", 2300)
        assertNull(state.poll(listOf(Scan("c", true, false)), 3000))
        assertEquals(Signal.RECEIVED, state.poll(listOf(Scan("c", true, true)), 3900))
    }
}
